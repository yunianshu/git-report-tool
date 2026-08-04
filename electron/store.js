/**
 * 配置持久化 —— 读写 userData/config.json（避免引入额外依赖）
 */
const { app } = require('electron')
const fs = require('fs')
const path = require('path')

function file() {
  return path.join(app.getPath('userData'), 'config.json')
}

const DEFAULTS = {
  roots: [],
  excludes: [],
  myIdentity: { name: '', email: '' },
}

function load() {
  try {
    const raw = fs.readFileSync(file(), 'utf8')
    return { ...DEFAULTS, ...JSON.parse(raw) }
  } catch {
    return { ...DEFAULTS }
  }
}

function save(cfg) {
  try {
    fs.writeFileSync(file(), JSON.stringify(cfg, null, 2), 'utf8')
    return true
  } catch {
    return false
  }
}

module.exports = { load, save }
