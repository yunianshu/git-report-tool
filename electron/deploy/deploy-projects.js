/**
 * 部署项目配置管理 —— 对应方案 §5.1 / §21 / §22：
 *   - 多项目配置（名称、本地目录、版本策略、服务器、部署选项、健康检查）
 *   - 持久化到 userData/deploy-projects.json（独立于报告配置，便于整体迁移）
 *   - SSH 密码/私钥口令经 safeStorage 加密落盘，明文不出主进程
 *     （渲染层仅收到 secretConfigured / masked 片段）
 */
const fs = require('fs')
const path = require('path')
const { app } = require('electron')
const store = require('../store')

function file() {
  return path.join(app.getPath('userData'), 'deploy-projects.json')
}

function defaultProject() {
  return {
    id: genId(),
    name: '',
    localPath: '',
    version: { strategy: 'auto', manual: '' },
    composeFile: 'docker-compose.yml',
    server: {
      host: '',
      port: 22,
      username: 'root',
      authType: 'password', // password | key
      keyPath: '',
    },
    deploy: {
      backupCode: true,
      backupDatabase: false,
      dbType: 'postgres', // postgres | mysql
      dbContainer: '',
      dbName: '',
      dbUser: '',
      autoRollback: true,
      deleteUploadAfterSuccess: true,
      keepReleases: 10,
      keepBackups: 10,
    },
    health: { enabled: true, url: '', timeout: 90, interval: 3 },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

function genId() {
  return `dp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/** 掩码展示用 */
function maskSecret(s) {
  if (!s) return '••••••'
  if (s.length <= 6) return '••••••'
  return `••••••${s.slice(-3)}`
}

/** 读取全部项目（脱敏）：明文凭据不出主进程 */
function list() {
  let projects = []
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8'))
    projects = Array.isArray(raw.projects) ? raw.projects : []
  } catch { /* 首次使用返回空 */ }
  return projects.map((p) => {
    const c = JSON.parse(JSON.stringify(p))
    const secret = store.decryptText(c.server && c.server.secret)
    const pass = store.decryptText(c.server && c.server.passphrase)
    if (c.server) {
      delete c.server.secret
      delete c.server.passphrase
      c.server.secretConfigured = !!secret
      c.server.secretMasked = secret ? maskSecret(secret) : ''
      c.server.passphraseConfigured = !!pass
    }
    return c
  })
}

/** 主进程专用：取项目明文凭据 */
function getCredentials(projectId) {
  const raw = JSON.parse(fs.readFileSync(file(), 'utf8'))
  const p = (raw.projects || []).find((x) => x.id === projectId)
  if (!p) return null
  return {
    password: store.decryptText(p.server && p.server.secret),
    passphrase: store.decryptText(p.server && p.server.passphrase),
  }
}

function loadAllRaw() {
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8'))
    return Array.isArray(raw.projects) ? raw.projects : []
  } catch {
    return []
  }
}

function persistAll(projects) {
  fs.mkdirSync(path.dirname(file()), { recursive: true })
  fs.writeFileSync(file(), JSON.stringify({ projects }, null, 2), { encoding: 'utf8', mode: 0o600 })
}

/**
 * 保存项目（新增或更新）。
 * 凭据规则（与 AI Key 相同）：
 *   - 传入 secret 非空 → 加密替换；空且未要求清除 → 保留既有；clearSecret=true → 清除
 *   - passphrase 同理（clearPassphrase）
 */
function save(input) {
  const projects = loadAllRaw()
  const incoming = { ...defaultProject(), ...JSON.parse(JSON.stringify(input || {})) }
  if (!incoming.id) incoming.id = genId()
  if (!incoming.createdAt) incoming.createdAt = Date.now()
  incoming.updatedAt = Date.now()

  const idx = projects.findIndex((p) => p.id === incoming.id)
  const old = idx >= 0 ? projects[idx] : null

  const s = incoming.server || {}
  const handleSecret = (key, clearKey) => {
    const plain = s[key] || ''
    delete s[key]
    const clearFlag = s[clearKey]
    delete s[clearKey]
    if (plain) {
      s[key] = store.encryptText(plain)
    } else if (clearFlag) {
      delete s[key]
    } else if (old && old.server && old.server[key]) {
      s[key] = old.server[key] // 字节原样保留，不触发解密
    }
  }
  handleSecret('secret', 'clearSecret')
  handleSecret('passphrase', 'clearPassphrase')

  if (idx >= 0) projects[idx] = { ...old, ...incoming }
  else projects.push(incoming)
  persistAll(projects)
  return { ok: true, id: incoming.id }
}

function remove(projectId) {
  const projects = loadAllRaw().filter((p) => p.id !== projectId)
  persistAll(projects)
  return { ok: true }
}

module.exports = { list, save, remove, getCredentials, defaultProject }
