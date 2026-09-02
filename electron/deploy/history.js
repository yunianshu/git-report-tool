/**
 * 发布历史 —— 对应方案 §19 / §27 DeployHistoryService：
 *   - 每次发布记录一条（版本、结果、各阶段耗时、失败原因）
 *   - 完整部署日志落盘 userData/deploy-logs/{id}.log，历史可回看
 *   - 保存于 userData/deploy-history.json（数组，最多 200 条）
 */
const fs = require('fs')
const path = require('path')
const { app } = require('electron')

const MAX_RECORDS = 200

function historyFile() {
  return path.join(app.getPath('userData'), 'deploy-history.json')
}

function logDir() {
  return path.join(app.getPath('userData'), 'deploy-logs')
}

function loadAll() {
  try {
    const raw = JSON.parse(fs.readFileSync(historyFile(), 'utf8'))
    return Array.isArray(raw.records) ? raw.records : []
  } catch {
    return []
  }
}

function list(projectId) {
  const all = loadAll()
  const rows = projectId ? all.filter((r) => r.projectId === projectId) : all
  return rows.slice().sort((a, b) => b.startedAt - a.startedAt).slice(0, MAX_RECORDS)
}

/** 写入完整部署日志文件，返回相对文件名（历史记录只存文件名） */
function writeLog(recordId, text) {
  const dir = logDir()
  fs.mkdirSync(dir, { recursive: true })
  const name = `${recordId}.log`
  fs.writeFileSync(path.join(dir, name), text || '', 'utf8')
  return name
}

/** 读取某条历史的完整日志 */
function readLog(logFile) {
  // 只允许读取 deploy-logs 目录内的 .log 文件，避免路径穿越
  const safe = path.basename(String(logFile || ''))
  if (!safe.endsWith('.log')) return ''
  try {
    return fs.readFileSync(path.join(logDir(), safe), 'utf8')
  } catch {
    return ''
  }
}

function add(record) {
  const records = loadAll()
  records.push(record)
  persist(records.slice(-MAX_RECORDS))
  return record
}

function update(recordId, patch) {
  const records = loadAll()
  const idx = records.findIndex((r) => r.id === recordId)
  if (idx >= 0) {
    records[idx] = { ...records[idx], ...patch }
    persist(records)
    return records[idx]
  }
  return null
}

function persist(records) {
  fs.mkdirSync(path.dirname(historyFile()), { recursive: true })
  fs.writeFileSync(historyFile(), JSON.stringify({ records }, null, 2), 'utf8')
}

function clear(projectId) {
  persist(projectId ? loadAll().filter((r) => r.projectId !== projectId) : [])
  return { ok: true }
}

module.exports = { list, add, update, writeLog, readLog, clear }
