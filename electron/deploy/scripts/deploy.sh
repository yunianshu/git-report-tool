#!/usr/bin/env bash
# ============================================================================
# OneDeploy 服务器端部署脚本
#
# 由 Windows 客户端经 SFTP 上传到 <部署目录>/deployer/deploy.sh 后通过 SSH 调用。
# 职责（方案 §10.2）：环境检查 / 备份 / 数据库备份 / 解压 / 版本目录管理 /
#   Docker 构建 / 重启 / 健康检查 / 自动回滚 / 清理旧版本与旧备份。
#
# 目录规范（方案 §8）：
#   <home>/
#     ├── current -> releases/<version>   软链接指向当前运行版本
#     ├── releases/  uploads/  backups/  shared/  deployer/
#
# 与客户端的协议：
#   阶段标记  __STAGE__:<name>        （backup-code / backup-db / extract / build / start / health / rollback）
#   结果标记  __DEPLOY_OK__:<msg>     __DEPLOY_FAIL__:<msg>
#   日志等级  [INFO] [OK] [WARN] [ERROR]
# ============================================================================
set -uo pipefail

# ───────────────────────── 日志与标记 ─────────────────────────
log()  { echo "[INFO]  $*"; }
ok()   { echo "[OK]    $*"; }
warn() { echo "[WARN]  $*"; }
err()  { echo "[ERROR] $*"; }
stage(){ echo "__STAGE__:$1"; }

fail_now() { # 前置检查失败（尚未改动任何服务器状态），直接报告失败
  err "$1"
  echo "__DEPLOY_FAIL__:$1"
  exit 1
}

# ───────────────────────── 参数解析 ─────────────────────────
CMD="deploy"
APP_NAME="" HOME_DIR="" PACKAGE="" SHA256="" VERSION="" COMPOSE_FILE="docker-compose.yml"
BACKUP_CODE=1 BACKUP_DB=0 DB_TYPE="postgres" DB_CONTAINER="" DB_NAME="" DB_USER=""
AUTO_ROLLBACK=1 HEALTH_URL="" HEALTH_TIMEOUT=90 HEALTH_INTERVAL=3
KEEP_RELEASES=10 KEEP_BACKUPS=10 DELETE_UPLOAD=1

if [ $# -gt 0 ]; then CMD="$1"; shift; fi

while [ $# -gt 0 ]; do
  case "$1" in
    --app)          APP_NAME="$2"; shift 2 ;;
    --home)         HOME_DIR="$2"; shift 2 ;;
    --package)      PACKAGE="$2"; shift 2 ;;
    --sha256)       SHA256="$2"; shift 2 ;;
    --compose)      COMPOSE_FILE="$2"; shift 2 ;;
    --version)      VERSION="$2"; shift 2 ;;
    --backup-code)      BACKUP_CODE=1; shift ;;
    --no-backup-code)   BACKUP_CODE=0; shift ;;
    --backup-db)        BACKUP_DB=1; shift ;;
    --no-backup-db)     BACKUP_DB=0; shift ;;
    --db-type)      DB_TYPE="$2"; shift 2 ;;
    --db-container) DB_CONTAINER="$2"; shift 2 ;;
    --db-name)      DB_NAME="$2"; shift 2 ;;
    --db-user)      DB_USER="$2"; shift 2 ;;
    --auto-rollback)    AUTO_ROLLBACK=1; shift ;;
    --no-auto-rollback) AUTO_ROLLBACK=0; shift ;;
    --health-url)      HEALTH_URL="$2"; shift 2 ;;
    --health-timeout)  HEALTH_TIMEOUT="$2"; shift 2 ;;
    --health-interval) HEALTH_INTERVAL="$2"; shift 2 ;;
    --no-health)       HEALTH_URL=""; shift ;;
    --keep-releases) KEEP_RELEASES="$2"; shift 2 ;;
    --keep-backups)  KEEP_BACKUPS="$2"; shift 2 ;;
    --delete-upload) DELETE_UPLOAD=1; shift ;;
    --keep-upload)   DELETE_UPLOAD=0; shift ;;
    *) shift ;;
  esac
done

# ───────────────────────── 全局状态 ─────────────────────────
APP_HOME="$HOME_DIR"
RELEASES="$APP_HOME/releases"
UPLOADS="$APP_HOME/uploads"
BACKUPS="$APP_HOME/backups"
SHARED="$APP_HOME/shared"
CURRENT="$APP_HOME/current"
LOCK_DIR="$APP_HOME/.deploy.lock"
LOCK_ACQUIRED=0
OLD_RELEASE=""
NEW_RELEASE=""
TS="$(date +%Y%m%d_%H%M%S)"

cleanup() {
  [ "$LOCK_ACQUIRED" = "1" ] && rm -rf "$LOCK_DIR" 2>/dev/null
  return 0
}
trap cleanup EXIT

acquire_lock() {
  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    # 锁超过 30 分钟视为残留（上一次异常退出），自动接管
    if [ -n "$(find "$LOCK_DIR" -maxdepth 0 -mmin +30 2>/dev/null)" ]; then
      warn "检测到过期发布锁，自动清理"
      rm -rf "$LOCK_DIR"
      mkdir "$LOCK_DIR" 2>/dev/null || fail_now "无法获取发布锁: $LOCK_DIR"
    else
      fail_now "另一个发布正在进行中（如确认卡死请删除 $LOCK_DIR）"
    fi
  fi
  LOCK_ACQUIRED=1
}

# ───────────────────────── 环境检查 ─────────────────────────
check_env() {
  command -v docker >/dev/null 2>&1 || fail_now "服务器未安装 docker"
  docker compose version >/dev/null 2>&1 || fail_now "服务器未安装 Docker Compose V2（需要 docker compose 子命令）"
  command -v unzip >/dev/null 2>&1 || fail_now "服务器未安装 unzip（如 CentOS: yum install -y unzip）"
  command -v sha256sum >/dev/null 2>&1 || fail_now "服务器未安装 sha256sum"
  if [ -n "$HEALTH_URL" ]; then
    command -v curl >/dev/null 2>&1 || fail_now "启用了健康检查但服务器未安装 curl"
  fi
  ok "服务器环境检查通过（docker/compose/unzip 可用）"
}

# ───────────────────────── 健康检查 ─────────────────────────
# HTTP 健康检查：总时长约 HEALTH_TIMEOUT 秒，每 HEALTH_INTERVAL 秒探测一次
health_http() {
  interval="$HEALTH_INTERVAL"; [ "$interval" -ge 1 ] 2>/dev/null || interval=3
  tries=$(( HEALTH_TIMEOUT / interval )); [ "$tries" -ge 1 ] 2>/dev/null || tries=1
  log "开始健康检查: $HEALTH_URL（最多 ${tries} 次，间隔 ${interval}s）"
  i=0
  while [ "$i" -lt "$tries" ]; do
    if curl -fsS --max-time 5 "$HEALTH_URL" >/dev/null 2>&1; then
      return 0
    fi
    i=$((i + 1))
    if [ $((i % 10)) -eq 0 ]; then log "健康检查已尝试 ${i}/${tries} 次…"; fi
    sleep "$interval"
  done
  return 1
}

# Docker 容器状态检查：项目内至少一个容器处于 Running
health_docker() {
  total=$(docker compose -f "$COMPOSE_FILE" ps -q 2>/dev/null | wc -l)
  [ "$total" -ge 1 ] || return 1
  for id in $(docker compose -f "$COMPOSE_FILE" ps -q 2>/dev/null); do
    st=$(docker inspect -f '{{.State.Running}}' "$id" 2>/dev/null || echo "false")
    [ "$st" = "true" ] && return 0
  done
  return 1
}

run_health() {
  if [ -n "$HEALTH_URL" ]; then
    health_http
  else
    health_docker
  fi
}

# ───────────────────────── 工具函数 ─────────────────────────
# 切换 current 软链接；兼容历史遗留的实体目录（非软链接）布局
link_current() {
  local target="$1"
  if [ -d "$CURRENT" ] && [ ! -L "$CURRENT" ]; then
    warn "current 为实体目录（非软链接），将移除后重建软链接"
    rm -rf "$CURRENT"
  fi
  ln -sfn "$target" "$CURRENT"
}

# ───────────────────────── 失败回滚 ─────────────────────────
do_rollback() {
  local reason="$1"
  stage rollback
  warn "$reason"
  write_history "failed"
  if [ "$AUTO_ROLLBACK" != "1" ]; then
    err "自动回滚未启用，保留新版本运行状态，请人工确认或使用客户端「回滚」按钮"
    echo "__DEPLOY_FAIL__:${reason}（自动回滚未启用，新版本保持运行）"
    exit 1
  fi
  if [ -n "$NEW_RELEASE" ] && [ -d "$NEW_RELEASE" ]; then
    (cd "$NEW_RELEASE" && docker compose -f "$COMPOSE_FILE" down >/dev/null 2>&1) || true
  fi
  if [ -n "$OLD_RELEASE" ] && [ -d "$OLD_RELEASE" ]; then
    link_current "$OLD_RELEASE"
    log "已切回旧版本: $(basename "$OLD_RELEASE")，正在启动…"
    (cd "$OLD_RELEASE" && docker compose -f "$COMPOSE_FILE" up -d >/dev/null 2>&1) || true
    if run_health; then
      ok "旧版本健康检查通过"
    else
      warn "旧版本健康检查未通过，请人工确认"
    fi
    echo "__DEPLOY_FAIL__:${reason}（已自动回滚到 $(basename "$OLD_RELEASE")）"
  else
    echo "__DEPLOY_FAIL__:${reason}（无旧版本可回滚）"
  fi
  exit 1
}

on_signal() { # SSH 连接被客户端取消/断开时触发
  do_rollback "发布被中断（连接断开/取消）"
}
trap on_signal HUP INT TERM

# ───────────────────────── 备份 ─────────────────────────
backup_code() {
  stage backup-code
  if [ "$BACKUP_CODE" != "1" ]; then warn "已跳过代码备份"; return 0; fi
  if [ -z "$OLD_RELEASE" ] || [ ! -d "$OLD_RELEASE" ]; then
    warn "无当前运行版本，跳过代码备份"
    return 0
  fi
  mkdir -p "$BACKUPS"
  local out="$BACKUPS/app_${TS}.tar.gz"
  tar -czf "$out" -C "$OLD_RELEASE" . 2>/dev/null || fail_rollback "代码备份失败: $out"
  ok "当前版本已备份: $out"
}

backup_db() {
  stage backup-db
  if [ "$BACKUP_DB" != "1" ]; then return 0; fi
  [ -n "$DB_CONTAINER" ] || fail_rollback "已启用数据库备份但未配置数据库容器名"
  [ -n "$DB_NAME" ] || fail_rollback "已启用数据库备份但未配置数据库名"
  mkdir -p "$BACKUPS"
  local out="$BACKUPS/db_${TS}.sql"
  case "$DB_TYPE" in
    postgres)
      docker exec "$DB_CONTAINER" pg_dump -U "${DB_USER:-postgres}" "$DB_NAME" > "$out" \
        || fail_rollback "PostgreSQL 备份失败（容器: $DB_CONTAINER 库: $DB_NAME）"
      ;;
    mysql)
      if [ -n "$DB_USER" ]; then
        docker exec "$DB_CONTAINER" mysqldump -u"$DB_USER" "$DB_NAME" > "$out" \
          || fail_rollback "MySQL 备份失败（容器: $DB_CONTAINER 库: $DB_NAME）"
      else
        # 未配置用户时使用容器内 MYSQL_ROOT_PASSWORD 环境变量
        docker exec "$DB_CONTAINER" sh -c 'exec mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" "$0"' "$DB_NAME" > "$out" \
          || fail_rollback "MySQL 备份失败（容器: $DB_CONTAINER 库: $DB_NAME）"
      fi
      ;;
    *) fail_rollback "不支持的数据库类型: $DB_TYPE" ;;
  esac
  ok "数据库已备份: $out"
}

# 备份阶段失败：尚未改动运行状态，直接失败退出
fail_rollback() {
  err "$1"
  echo "__DEPLOY_FAIL__:$1"
  exit 1
}

# ───────────────────────── 清理 ─────────────────────────
cleanup_releases() {
  # 按 mtime 保留最近 KEEP_RELEASES 个版本，当前运行的版本永不删除
  [ -d "$RELEASES" ] || return 0
  local keep_current
  keep_current=$(basename "$(readlink -f "$CURRENT" 2>/dev/null || echo)" 2>/dev/null || echo "")
  local count=0 victim
  ls -1t "$RELEASES" 2>/dev/null | while read -r victim; do
    count=$((count + 1))
    [ "$count" -le "$KEEP_RELEASES" ] && continue
    [ "$victim" = "$keep_current" ] && continue
    rm -rf "$RELEASES/$victim"
    log "清理旧版本: $victim"
  done
}

cleanup_backups() {
  [ -d "$BACKUPS" ] || return 0
  # 代码备份与数据库备份分别保留 KEEP_BACKUPS 份
  ls -1t "$BACKUPS"/app_*.tar.gz 2>/dev/null | tail -n +$((KEEP_BACKUPS + 1)) | while read -r f; do
    rm -f "$f"; log "清理旧代码备份: $(basename "$f")"
  done
  ls -1t "$BACKUPS"/db_*.sql 2>/dev/null | tail -n +$((KEEP_BACKUPS + 1)) | while read -r f; do
    rm -f "$f"; log "清理旧数据库备份: $(basename "$f")"
  done
}

write_history() {
  # 服务器端简易历史（JSONL），客户端另有完整发布历史
  mkdir -p "$APP_HOME"
  printf '{"version":"%s","status":"%s","time":"%s"}\n' \
    "${VERSION:-unknown}" "$1" "$(date '+%Y-%m-%d %H:%M:%S')" \
    >> "$APP_HOME/deploy-history.jsonl" 2>/dev/null
}

# ═════════════════════════ 子命令: deploy ═════════════════════════
do_deploy() {
  [ -n "$APP_NAME" ] || fail_now "缺少 --app"
  [ -n "$HOME_DIR" ] || fail_now "缺少 --home"
  [ -n "$VERSION" ]  || fail_now "缺少 --version"
  [ -n "$PACKAGE" ]  || fail_now "缺少 --package"

  mkdir -p "$RELEASES" "$UPLOADS" "$BACKUPS" "$SHARED"
  [ -w "$APP_HOME" ] || fail_now "部署目录不可写: $APP_HOME"
  acquire_lock
  check_env

  # 校验上传包（方案 §27 SftpUploader：上传后校验）
  local pkg="$UPLOADS/$PACKAGE"
  [ -f "$pkg" ] || fail_now "发布包不存在: $pkg"
  if [ -n "$SHA256" ]; then
    local remote_sha
    remote_sha=$(sha256sum "$pkg" | awk '{print $1}')
    [ "$remote_sha" = "$SHA256" ] || fail_now "发布包校验失败（期望 $SHA256 实际 $remote_sha）"
    ok "发布包 SHA256 校验通过"
  fi

  # 记录旧版本（方案 §11.2）
  OLD_RELEASE="$(readlink -f "$CURRENT" 2>/dev/null || echo "")"
  [ -n "$OLD_RELEASE" ] && log "当前运行版本目录: $(basename "$OLD_RELEASE")" || log "首次发布，无旧版本"

  backup_code
  backup_db

  # 解压新版本（方案 §11.4）
  stage extract
  NEW_RELEASE="$RELEASES/$VERSION"
  rm -rf "$NEW_RELEASE"
  mkdir -p "$NEW_RELEASE"
  unzip -q -o "$pkg" -d "$NEW_RELEASE" || fail_rollback "解压失败: $pkg"
  ok "新版本已解压: releases/$VERSION"

  # 共享配置（方案 §11.5）：.env 由 shared 目录软链，不随版本删除
  if [ -f "$SHARED/.env" ] && [ ! -e "$NEW_RELEASE/.env" ]; then
    ln -s "$SHARED/.env" "$NEW_RELEASE/.env"
    ok "已链接共享配置 shared/.env"
  fi
  # compose 文件在子目录时（如 deploy/docker-compose.yml），
  # docker compose 的变量替换读取该子目录下的 .env，需一并软链
  local compose_dir
  compose_dir="$(dirname "$COMPOSE_FILE")"
  if [ "$compose_dir" != "." ] && [ -f "$SHARED/.env" ] && [ ! -e "$NEW_RELEASE/$compose_dir/.env" ]; then
    mkdir -p "$NEW_RELEASE/$compose_dir"
    ln -s "$SHARED/.env" "$NEW_RELEASE/$compose_dir/.env"
    ok "已链接共享配置到 $compose_dir/.env"
  fi

  # Docker 构建（方案 §12）
  stage build
  log "Docker 镜像构建中（docker compose build）…"
  (cd "$NEW_RELEASE" && docker compose -f "$COMPOSE_FILE" build) \
    || do_rollback "Docker 镜像构建失败"
  ok "Docker 镜像构建完成"

  # 启动服务：先停旧容器释放端口，再启动新版本
  stage start
  if [ -n "$OLD_RELEASE" ] && [ -d "$OLD_RELEASE" ]; then
    log "停止旧版本容器…"
    (cd "$OLD_RELEASE" && docker compose -f "$COMPOSE_FILE" down >/dev/null 2>&1) || true
  fi
  (cd "$NEW_RELEASE" && docker compose -f "$COMPOSE_FILE" up -d) \
    || do_rollback "Docker 服务启动失败"
  ok "Docker 服务已启动"

  # 健康检查（方案 §13）：容器存活 + 业务 HTTP
  stage health
  if [ -z "$HEALTH_URL" ]; then
    if health_docker; then ok "容器状态健康（未配置 HTTP 健康检查）"
    else do_rollback "容器启动状态异常"; fi
  else
    if run_health; then ok "健康检查通过: $HEALTH_URL"
    else do_rollback "健康检查失败: $HEALTH_URL"; fi
  fi

  # 切换 current 软链接 → 新版本生效
  link_current "$NEW_RELEASE"
  ok "current -> releases/$VERSION"

  cleanup_releases
  cleanup_backups
  if [ "$DELETE_UPLOAD" = "1" ]; then
    rm -f "$pkg"
    log "已清理上传包: $PACKAGE"
  fi
  write_history "success"

  echo "__DEPLOY_OK__:$VERSION"
  exit 0
}

# ═════════════════════════ 子命令: rollback ═════════════════════════
do_rollback_cmd() {
  [ -n "$HOME_DIR" ] || fail_now "缺少 --home"
  [ -n "$VERSION" ]  || fail_now "缺少 --version"

  [ -d "$RELEASES/$VERSION" ] || fail_now "目标版本不存在: releases/$VERSION"
  acquire_lock

  local target="$RELEASES/$VERSION"
  OLD_RELEASE="$(readlink -f "$CURRENT" 2>/dev/null || echo "")"
  NEW_RELEASE="" # 手动回滚无需再回滚

  stage start
  if [ -n "$OLD_RELEASE" ] && [ -d "$OLD_RELEASE" ] && [ "$OLD_RELEASE" != "$(readlink -f "$target")" ]; then
    log "停止当前版本容器…"
    (cd "$OLD_RELEASE" && docker compose -f "$COMPOSE_FILE" down >/dev/null 2>&1) || true
  fi
  link_current "$target"
  log "current -> releases/$VERSION，正在启动…"
  (cd "$target" && docker compose -f "$COMPOSE_FILE" up -d) \
    || fail_now "目标版本启动失败: releases/$VERSION"

  stage health
  if [ -n "$HEALTH_URL" ]; then
    run_health || fail_now "回滚后健康检查失败: $HEALTH_URL"
  else
    health_docker || fail_now "回滚后容器状态异常"
  fi
  ok "回滚完成，当前版本: $VERSION"
  write_history "rollback"

  echo "__DEPLOY_OK__:$VERSION"
  exit 0
}

case "$CMD" in
  deploy)   do_deploy ;;
  rollback) do_rollback_cmd ;;
  *) fail_now "未知子命令: $CMD（支持 deploy / rollback）" ;;
esac
