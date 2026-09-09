/**
 * 报告历史记录 —— 自动保存生成的历史报告
 * 元信息存 userData/reports.json，正文存 userData/reports/<id>.md
 */
const { app } = require('electron')
const fs = require('fs')
const path = require('path')

function reportsDir() {
  return path.join(app.getPath('userData'), 'reports')
}
function indexFile() {
  return path.join(app.getPath('userData'), 'reports.json')
}

function readIndex() {
  try {
    return JSON.parse(fs.readFileSync(indexFile(), 'utf8'))
  } catch {
    return { reports: [] }
  }
}
function writeIndex(idx) {
  try {
    fs.writeFileSync(indexFile(), JSON.stringify(idx, null, 2), 'utf8')
  } catch { /* noop */ }
}

/** 历史列表（新→旧） */
function list() {
  return readIndex().reports.sort((a, b) => (a.id < b.id ? 1 : -1))
}

/** 历史上限：超出后裁剪最旧记录，并同步删除其正文文件（防无限增长） */
const MAX_REPORTS = 200

/** 删除被裁剪记录的正文文件（basename 防穿越；失败静默） */
function removeReportFiles(records) {
  for (const rec of records || []) {
    const file = rec && rec.file
    if (typeof file !== 'string' || !file.endsWith('.md')) continue
    try { fs.rmSync(path.join(reportsDir(), path.basename(file)), { force: true }) } catch { /* noop */ }
  }
}

/** 生成唯一 ID：毫秒时间戳 + 同毫秒自增序号（快速连续保存时 Date.now() 会碰撞，
 *  多份报告共用同一正文文件互相覆盖） */
let lastIdMs = 0
let idSeq = 0
function nextId() {
  const now = Date.now()
  if (now === lastIdMs) idSeq += 1
  else { lastIdMs = now; idSeq = 0 }
  return `${now}-${idSeq}`
}

/** 自动保存一份报告，返回记录 */
function save(payload) {
  const { title, content, period = '', dateRange = '', commitCount = 0, projectCount = 0 } = payload || {}
  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const id = nextId()
  const createdAt = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`

  fs.mkdirSync(reportsDir(), { recursive: true })
  const file = path.join(reportsDir(), `${id}.md`)
  fs.writeFileSync(file, content || '', 'utf8')

  const idx = readIndex()
  idx.reports.push({
    id,
    title: title || '',
    period,
    dateRange,
    commitCount,
    projectCount,
    file: path.relative(app.getPath('userData'), file),
    createdAt,
  })
  // 注意不能用 slice(0, len - MAX)：len < MAX 时 end 为负表示从末尾倒数，会误删保留范围内的记录
  const kept = idx.reports.slice(-MAX_REPORTS)
  const dropped = idx.reports.slice(0, Math.max(0, idx.reports.length - MAX_REPORTS))
  writeIndex({ reports: kept })
  removeReportFiles(dropped)
  return { id, title, createdAt }
}

/** 读取某条历史（含正文） */
function read(id) {
  const rec = readIndex().reports.find((r) => r.id === id)
  if (!rec) return null
  try {
    return { ...rec, content: fs.readFileSync(path.join(app.getPath('userData'), rec.file), 'utf8') }
  } catch {
    return null
  }
}

/** 删除某条历史 */
function remove(id) {
  const idx = readIndex()
  const rec = idx.reports.find((r) => r.id === id)
  if (rec) {
    try { fs.unlinkSync(path.join(app.getPath('userData'), rec.file)) } catch { /* noop */ }
    idx.reports = idx.reports.filter((r) => r.id !== id)
    writeIndex(idx)
  }
  return true
}

module.exports = { list, save, read, remove }
