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

/** 自动保存一份报告，返回记录 */
function save(payload) {
  const { title, content, period = '', dateRange = '', commitCount = 0, projectCount = 0 } = payload || {}
  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const id = String(Date.now())
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
  writeIndex(idx)
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
