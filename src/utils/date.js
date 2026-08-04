export function pad(n) {
  return String(n).padStart(2, '0')
}

export function todayStr() {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 在 YYYY-MM-DD 基础上加减天数 */
export function addDays(dateStr, days) {
  if (!dateStr) return ''
  const d = new Date(`${dateStr}T00:00:00`)
  d.setDate(d.getDate() + days)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** git 的 --until 为排他语义，展示时减一天得到实际截止日 */
export function untilToEnd(until) {
  return until ? addDays(until, -1) : ''
}
