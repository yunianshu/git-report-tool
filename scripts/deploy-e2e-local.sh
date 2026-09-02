#!/usr/bin/env bash
# ============================================================================
# OneDeploy 服务器脚本本地演练（无 Docker 服务器环境下验证 deploy.sh 逻辑）
# 用桩程序模拟 docker / curl，覆盖：完整成功流程 / 健康检查失败自动回滚 /
# SHA256 校验失败 / 发布锁。Linux 用户也可用真实 docker 替换桩后直接运行。
# 运行：bash scripts/deploy-e2e-local.sh
# ============================================================================
set -u
# Git Bash 下强制 ln -s 生成原生符号链接（模拟 Linux 软链接语义，需管理员/开发者模式）
export MSYS=winsymlinks:nativestrict
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"
STUB="$WORK/stub-bin"
HOME_DIR="$WORK/app-home"
mkdir -p "$STUB" "$HOME_DIR"

PASS=0; FAIL=0
check() { # check "名称" "期望包含" "实际输出"
  if echo "$3" | grep -q "$2"; then PASS=$((PASS+1)); echo "  ✓ $1"
  else FAIL=$((FAIL+1)); echo "  ✗ $1"; echo "    期望包含: $2"; echo "    实际: $(echo "$3" | tail -5 | tr '\n' '|')"; fi
}

# ── 桩：docker ──
cat > "$STUB/docker" <<'EOF'
#!/usr/bin/env bash
if [ "$1" = "compose" ] && [ "$2" = "version" ]; then echo "Docker Compose version v2.29.0-stub"; exit 0; fi
if [ "$1" = "compose" ]; then
  verb="$4"
  case "$verb" in
    build|up|down) exit 0 ;;
    ps) echo "stub-container-id" ;;
    exec) echo "DUMPDATA" ;;
    *) exit 0 ;;
  esac
fi
case "$1" in
  inspect) echo "true" ;;
  exec) echo "DUMPDATA" ;;
  --version) echo "Docker version 27.0.0-stub" ;;
esac
exit 0
EOF

# ── 桩：curl（模式由 CURL_STUB_MODE 控制） ──
cat > "$STUB/curl" <<'EOF'
#!/usr/bin/env bash
if [ "${CURL_STUB_MODE:-ok}" = "fail" ]; then exit 7; fi
echo '{"status":"UP"}'
exit 0
EOF

# ── 桩：unzip（用 Windows 自带 bsdtar 解压） ──
cat > "$STUB/unzip" <<'EOF'
#!/usr/bin/env bash
src=""; dest="."
for a in "$@"; do
  case "$a" in -*) ;; *) if [ -z "$src" ]; then src="$a"; else dest="$a"; fi ;; esac
done
mkdir -p "$dest"
tar -xf "$src" -C "$dest"
EOF

chmod +x "$STUB"/*
export PATH="$STUB:$PATH"
SCRIPT="$HERE/../electron/deploy/scripts/deploy.sh"

# ── 准备一个真实 ZIP 发布包 ──
PROJ="$WORK/proj"
mkdir -p "$PROJ"
echo '{"version":"3.0.0"}' > "$PROJ/package.json"
echo 'console.log(1)' > "$PROJ/app.js"
ZIP="$WORK/testapp-3.0.0.zip"
( cd "$PROJ" && tar -a -cf "$ZIP" . )
REAL_SHA=$(sha256sum "$ZIP" | awk '{print $1}')

echo "＝＝＝ 场景 1：完整成功发布（代码+数据库备份，HTTP 健康检查） ＝＝＝"
mkdir -p "$HOME_DIR/uploads" && cp "$ZIP" "$HOME_DIR/uploads/" # 模拟客户端 SFTP 上传
OUT=$(bash "$SCRIPT" deploy \
  --app testapp --home "$HOME_DIR" --package "$(basename "$ZIP")" \
  --sha256 "$REAL_SHA" --compose docker-compose.yml --version 3.0.0 \
  --backup-code --backup-db --db-type postgres --db-container pgs --db-name testdb \
  --auto-rollback --health-url "http://127.0.0.1:8080/actuator/health" \
  --health-timeout 30 --health-interval 1 --keep-upload 2>&1)
check "发布成功标记" "__DEPLOY_OK__:3.0.0" "$OUT"
check "SHA256 校验通过" "发布包 SHA256 校验通过" "$OUT"
check "首次发布跳过代码备份" "无当前运行版本，跳过代码备份" "$OUT"
check "数据库备份完成" "数据库已备份" "$OUT"
check "健康检查通过" "健康检查通过" "$OUT"
check "current 软链切换" "current -> releases/3.0.0" "$OUT"
[ -f "$HOME_DIR/backups/db_"*.sql ] && echo "  ✓ 数据库备份文件存在（含 DUMPDATA）" || { echo "  ✗ 缺少数据库备份文件"; FAIL=$((FAIL+1)); }
grep -q DUMPDATA "$HOME_DIR"/backups/db_*.sql && PASS=$((PASS+1)) || { echo "  ✗ pg_dump 输出未落盘"; FAIL=$((FAIL+1)); }
[ -f "$HOME_DIR/deploy-history.jsonl" ] && grep -q '"status":"success"' "$HOME_DIR/deploy-history.jsonl" \
  && echo "  ✓ 服务器端历史已记录" || { echo "  ✗ 服务器端历史缺失"; FAIL=$((FAIL+1)); }

echo "＝＝＝ 场景 2：二次发布 3.1.0 → 健康检查失败 → 自动回滚到 3.0.0 ＝＝＝"
echo '{"version":"3.1.0"}' > "$PROJ/package.json"
ZIP2="$WORK/testapp-3.1.0.zip"
( cd "$PROJ" && tar -a -cf "$ZIP2" . )
SHA2=$(sha256sum "$ZIP2" | awk '{print $1}')
cp "$ZIP2" "$HOME_DIR/uploads/" # 模拟客户端 SFTP 上传
OUT=$(CURL_STUB_MODE=fail bash "$SCRIPT" deploy \
  --app testapp --home "$HOME_DIR" --package "$(basename "$ZIP2")" \
  --sha256 "$SHA2" --compose docker-compose.yml --version 3.1.0 \
  --backup-code --auto-rollback \
  --health-url "http://127.0.0.1:8080/actuator/health" \
  --health-timeout 3 --health-interval 1 --delete-upload 2>&1)
check "失败标记" "__DEPLOY_FAIL__" "$OUT"
check "二次发布先备份 3.0.0" "当前版本已备份" "$OUT"
check "触发自动回滚" "已自动回滚到 3.0.0" "$OUT"
check "回滚阶段标记" "__STAGE__:rollback" "$OUT"
CUR_TARGET=$(basename "$(readlink -f "$HOME_DIR/current" 2>/dev/null)" 2>/dev/null)
[ "$CUR_TARGET" = "3.0.0" ] && echo "  ✓ current 已指回 3.0.0" || { echo "  ✗ current 指向: ${CUR_TARGET:-无}"; FAIL=$((FAIL+1)); }
grep -q '"status":"failed"' "$HOME_DIR/deploy-history.jsonl" && echo "  ✓ 历史记录含失败状态" || { echo "  ✗ 失败历史缺失"; FAIL=$((FAIL+1)); }
[ ! -f "$HOME_DIR/uploads/$(basename "$ZIP2")" ] && echo "  ✓ --delete-upload 未生效（失败场景保留现场）" || echo "  · 上传包仍在（失败场景）"

echo "＝＝＝ 场景 3：SHA256 校验失败 → 拒绝发布 ＝＝＝"
OUT=$(bash "$SCRIPT" deploy \
  --app testapp --home "$HOME_DIR" --package "$(basename "$ZIP")" \
  --sha256 "deadbeef00000000000000000000000000000000000000000000000000000000" \
  --compose docker-compose.yml --version 9.9.9 2>&1)
check "校验失败标记" "发布包校验失败" "$OUT"
check "失败结果标记" "__DEPLOY_FAIL__" "$OUT"

echo "＝＝＝ 场景 4：发布锁防并发 ＝＝＝"
mkdir -p "$HOME_DIR/.deploy.lock"
OUT=$(bash "$SCRIPT" deploy \
  --app testapp --home "$HOME_DIR" --package "$(basename "$ZIP")" --sha256 "$REAL_SHA" \
  --compose docker-compose.yml --version 4.0.0 2>&1)
check "锁冲突提示" "另一个发布正在进行中" "$OUT"
rmdir "$HOME_DIR/.deploy.lock"

echo "＝＝＝ 场景 5：手动回滚子命令（无健康检查→容器状态检查） ＝＝＝"
OUT=$(bash "$SCRIPT" rollback \
  --app testapp --home "$HOME_DIR" --compose docker-compose.yml --version 3.0.0 2>&1)
check "手动回滚成功" "__DEPLOY_OK__:3.0.0" "$OUT"
check "回滚完成提示" "回滚完成" "$OUT"

echo
echo "演练结果: $PASS 通过, $FAIL 失败（工作目录: $WORK）"
[ "$FAIL" = "0" ] || exit 1
