#!/bin/bash
#
# collect_git_reports.sh — 跨项目 Git 提交收集脚本（便携版，可复制给他人使用）
#
# 依赖: git, find, awk, sort, mktemp
#        Windows 用户请使用 Git Bash / MSYS2；macOS / Linux 直接可用
#
# 功能:
#   1. 在指定根目录下递归发现所有 Git 仓库（自动排除常见 SDK/缓存/系统目录）
#   2. 对每个仓库执行 git log 收集提交
#   3. 输出 TSV 数据，供日报/周报/月报聚合使用
#
# 用法:
#   ./collect_git_reports.sh [选项]
#
# 选项:
#   -r DIR   扫描根目录（可多次指定；默认: 当前目录）
#   -s DATE  起始日期 YYYY-MM-DD，收集该日(含)之后提交（默认: 30 天前）
#   -u DATE  截止日期 YYYY-MM-DD，收集该日(含)之前提交（可选）
#   -a NAME  按作者姓名/邮箱过滤（可多次指定；不指定则收集全部作者）
#   -o DIR   输出目录（默认: ./gitreport_out）
#   -h       显示帮助
#
# 示例:
#   # 扫描 D 盘两个项目目录，收集近 30 天本人提交
#   ./collect_git_reports.sh -r /d/AiProject -r /d/AndroidProjectNet \
#       -s 2026-07-05 -a yunainshu -o /d/out
#
# 输出:
#   <out>/repos.txt      发现的有效仓库清单
#   <out>/commits.tsv    提交数据（TAB 分隔: 仓库\t日期\t哈希\t作者名\t作者邮箱\t消息）
#                         以及末尾的统计信息（stdout）

set -uo pipefail

# ---------- 默认值 ----------
ROOTS=()
SINCE="$(date -d '30 days ago' '+%Y-%m-%d' 2>/dev/null || date -v-30d '+%Y-%m-%d')"
UNTIL=""
AUTHORS=()
OUT="$(pwd)/gitreport_out"

# 默认排除的目录（第三方克隆 / SDK / 缓存 / 系统目录），可按需增删
DEFAULT_EXCLUDES=(
  'node_modules'
  '.git/modules'
  'FlutterSDK'
  'fvm_cache'
  '__MACOSX'
  '.cache'
  'android-sdk'
  'androidsdk'
  'jdk'
  'Program Files'
  'System Volume Information'
  '$RECYCLE.BIN'
)

# ---------- 解析参数 ----------
usage() {
  sed -n '2,44p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
}
while getopts "r:s:u:a:o:h" opt; do
  case "$opt" in
    r) ROOTS+=("$OPTARG") ;;
    s) SINCE="$OPTARG" ;;
    u) UNTIL="$OPTARG" ;;
    a) AUTHORS+=("$OPTARG") ;;
    o) OUT="$OPTARG" ;;
    h) usage ;;
    *) usage ;;
  esac
done
[ ${#ROOTS[@]} -eq 0 ] && ROOTS=(".")
mkdir -p "$OUT"

# ---------- 1. 发现仓库 ----------
REPOLIST="$OUT/repos.txt"
: > "$REPOLIST"
for root in "${ROOTS[@]}"; do
  [ -d "$root" ] || { echo "[跳过] 目录不存在: $root" >&2; continue; }
  tmp=$(mktemp)
  find "$root" -type d -name .git 2>/dev/null > "$tmp"
  while IFS= read -r gd; do
    [ -z "$gd" ] && continue
    skip=0
    for pat in "${DEFAULT_EXCLUDES[@]}"; do
      case "$gd" in
        *"$pat"*) skip=1; break ;;
      esac
    done
    [ "$skip" -eq 1 ] && continue
    echo "${gd%/.git}" >> "$REPOLIST"
  done < "$tmp"
  rm -f "$tmp"
done
sort -u "$REPOLIST" -o "$REPOLIST"
echo "[发现] 有效仓库数: $(wc -l < "$REPOLIST" | tr -d ' ')"

# ---------- 2. 收集提交 ----------
TSV="$OUT/commits.tsv"
: > "$TSV"
while IFS= read -r repo; do
  [ -z "$repo" ] && continue
  [ -d "$repo/.git" ] || continue
  disp="${repo#/}"
  # 注意: 必须用 tformat:（每条提交后强制换行），format: 会让相邻仓库首尾行粘连
  baseargs=(log --all --since="$SINCE" --no-merges
            --pretty=tformat:"$disp%x09%ad%x09%h%x09%an%x09%ae%x09%s" --date=short)
  [ -n "$UNTIL" ] && baseargs+=(--until="$UNTIL")
  if [ ${#AUTHORS[@]} -gt 0 ]; then
    for a in "${AUTHORS[@]}"; do
      git -C "$repo" "${baseargs[@]}" --author="$a" 2>/dev/null >> "$TSV" || true
      echo "" >> "$TSV"   # 仓库/作者间补空行分隔
    done
  else
    git -C "$repo" "${baseargs[@]}" 2>/dev/null >> "$TSV" || true
    echo "" >> "$TSV"
  fi
done < "$REPOLIST"

# 清洗：仅保留完整 6 列数据行
tmp2=$(mktemp)
awk -F'\t' 'NF>=6' "$TSV" > "$tmp2" && mv "$tmp2" "$TSV"

# ---------- 3. 统计输出 ----------
echo "[统计] 提交总数: $(wc -l < "$TSV" | tr -d ' ')"
echo "[统计] 涉及仓库数: $(awk -F'\t' '{print $1}' "$TSV" | sort -u | wc -l | tr -d ' ')"
echo "[统计] 按仓库:"
awk -F'\t' '{c[$1]++} END{for(r in c) print "  "c[r]"\t"r}' "$TSV" | sort -rn | head -30
echo "[输出] 仓库清单: $OUT/repos.txt"
echo "[输出] 提交数据: $OUT/commits.tsv"
