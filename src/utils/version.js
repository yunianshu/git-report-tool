/** 语义化版本号工具（spec R7）：解析、递增、比较与取最高 */

/** 解析 x.y.z（允许 v 前缀与 -beta 等后缀），返回 [major, minor, patch]；无法解析返回 null */
export function parseVersion(v) {
  const m = String(v == null ? '' : v).trim().match(/^v?(\d+)\.(\d+)\.(\d+)/)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

/** 三段递增：patch 修复补丁 / minor 新功能 / major 大版本；无法解析返回空串 */
export function bumpVersion(base, level) {
  const p = parseVersion(base)
  if (!p) return ''
  const [maj, min, pat] = p
  if (level === 'major') return `${maj + 1}.0.0`
  if (level === 'minor') return `${maj}.${min + 1}.0`
  return `${maj}.${min}.${pat + 1}`
}

/** 版本号比较：a > b 返回 1，相等 0，a < b 返回 -1；无法解析者视为最小 */
export function compareVersion(a, b) {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa) return pb ? -1 : 0
  if (!pb) return 1
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1
  }
  return 0
}

/** 从版本串集合中取最高者，无法解析的忽略；全部无法解析返回空串 */
export function highestVersion(list) {
  let best = ''
  for (const v of list || []) {
    if (!parseVersion(v)) continue
    if (!best || compareVersion(v, best) > 0) best = String(v).trim()
  }
  return best
}
