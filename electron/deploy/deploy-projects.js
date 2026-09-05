/**
 * 部署项目配置管理 —— 对应方案 §5.1 / §21 / §22：
 *   - 多项目配置（名称、本地目录、版本策略、部署选项）
 *   - 每个项目支持多个部署目标 targets[]（测试/生产等多环境）：
 *     各目标独立的服务器（host/端口/用户/认证/密钥）、远程部署目录与健康检查
 *   - 持久化到 userData/deploy-projects.json；旧版单服务器配置自动迁移为 targets[0]
 *   - SSH 密码/私钥口令按目标分别经 safeStorage 加密落盘，明文不出主进程
 */
const fs = require('fs')
const path = require('path')
const { app } = require('electron')
const store = require('../store')

function file() {
  return path.join(app.getPath('userData'), 'deploy-projects.json')
}

function genId() {
  return `dp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function defaultServer() {
  return { host: '', port: 22, username: 'root', authType: 'password', keyPath: '' }
}

/** 目标级数据同步配置：发布成功后把本地数据目录推送到服务器共享目录 */
function normalizeDataSync(raw) {
  const s = raw && typeof raw === 'object' ? raw : {}
  const str = (v, fallback) => {
    const out = String(v ?? fallback).trim()
    return out
  }
  return {
    enabled: s.enabled === true,
    // 相对项目根的数据目录；禁止绝对路径与 ..（防越界打包）
    localDir: str(s.localDir, 'data'),
    // 相对远程部署目录；shared/ 跨版本共享，发布/回滚不影响数据
    remoteDir: str(s.remoteDir, 'shared/data'),
    // 同步后导入钩子：'none' | 'command'——发布同步文件后在服务器上执行导入命令
    importMode: s.importMode === 'command' ? 'command' : 'none',
    // 占位符：{dataDir}=远端数据目录绝对路径 {user}/{secret}=下方账号凭据
    importCommand: typeof s.importCommand === 'string' ? s.importCommand : '',
    importUser: str(s.importUser, ''),
    // importSecret 原样保留（明文字符串或加密对象），由 save() 的 mergeSecret 统一加密合并
    importSecret: s.importSecret ?? null,
  }
}

/** 单个部署目标（环境） */
function defaultTarget() {
  return {
    id: genId(),
    name: '默认环境',
    server: defaultServer(),
    remotePath: '',
    health: { enabled: true, url: '', timeout: 90, interval: 3 },
    dataSync: normalizeDataSync(),
  }
}

function defaultProject() {
  return {
    id: genId(),
    name: '',
    description: '',
    localPath: '',
    status: 'active',
    tags: [],
    notes: '',
    version: { strategy: 'auto', manual: '' },
    composeFile: 'docker-compose.yml',
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
    targets: [defaultTarget()],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

/**
 * 旧版迁移：项目根上的 server/health/remotePath → targets[0]。
 * 读取与保存路径统一走此函数，保证任何入口拿到的都是新结构。
 */
function normalizeProject(p) {
  const source = JSON.parse(JSON.stringify(p || {}))
  const defaults = defaultProject()
  const c = {
    ...defaults,
    ...source,
    version: { ...defaults.version, ...(source.version || {}) },
    deploy: { ...defaults.deploy, ...(source.deploy || {}) },
  }
  c.name = String(c.name || '').trim()
  c.description = String(c.description || '')
  c.localPath = String(c.localPath || '')
  c.status = ['active', 'paused', 'archived'].includes(c.status) ? c.status : 'active'
  c.tags = [...new Set((Array.isArray(c.tags) ? c.tags : []).map((x) => String(x).trim()).filter(Boolean))]
  c.notes = String(c.notes || '')
  // 本地调试模式：bat = 运行根目录 start.bat（默认）；off = 该项目不需要本地调试
  c.debugMode = c.debugMode === 'off' ? 'off' : 'bat'

  if (!Array.isArray(source.targets) || !source.targets.length) {
    const t = defaultTarget()
    if (source.server && (source.server.host || source.server.remotePath || source.remotePath)) {
      t.server = { ...defaultServer(), ...source.server }
      // 旧格式 remotePath 位于 server 内部（deploy-service 旧版读 project.server.remotePath）
      t.remotePath = (source.server && source.server.remotePath) || source.remotePath || ''
      t.health = { ...defaultTarget().health, ...(source.health || {}) }
      t.name = '默认环境'
    }
    c.targets = [t]
  } else {
    c.targets = source.targets
  }
  c.targets = c.targets.map((t) => ({
    ...defaultTarget(),
    ...t,
    server: { ...defaultServer(), ...(t.server || {}) },
    health: { ...defaultTarget().health, ...(t.health || {}) },
    dataSync: normalizeDataSync(t.dataSync),
  }))
  delete c.server
  delete c.health
  delete c.remotePath
  return c
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
  return projects.map(normalizeProject).map((p) => {
    p.targets = p.targets.map((t) => {
      const secret = store.decryptText(t.server && t.server.secret)
      const pass = store.decryptText(t.server && t.server.passphrase)
      const s = { ...t.server }
      delete s.secret
      delete s.passphrase
      s.secretConfigured = !!secret
      s.secretMasked = secret ? maskSecret(secret) : ''
      s.passphraseConfigured = !!pass
      // 数据同步导入凭据：加密对象不出主进程，只回配置状态与掩码
      const ds = { ...(t.dataSync || {}) }
      const importSecret = store.decryptText(ds.importSecret)
      delete ds.importSecret
      ds.importSecretConfigured = !!importSecret
      if (importSecret) ds.importSecretMasked = maskSecret(importSecret)
      return { ...t, server: s, dataSync: ds }
    })
    return p
  })
}

function loadAllRaw() {
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8'))
    return (Array.isArray(raw.projects) ? raw.projects : []).map(normalizeProject)
  } catch {
    return []
  }
}

/** 主进程专用：取某项目某目标的明文凭据（targetId 省略时用第一个目标） */
function getCredentials(projectId, targetId) {
  const p = loadAllRaw().find((x) => x.id === projectId)
  if (!p) return null
  const t = p.targets.find((x) => x.id === targetId) || p.targets[0]
  if (!t) return { password: '', passphrase: '' }
  return {
    password: store.decryptText(t.server && t.server.secret),
    passphrase: store.decryptText(t.server && t.server.passphrase),
  }
}

/** 主进程专用：取数据同步导入钩子的明文凭据（list() 脱敏后不含，需走原始数据） */
function getDataSyncCredentials(projectId, targetId) {
  const p = loadAllRaw().find((x) => x.id === projectId)
  const t = p && (p.targets.find((x) => x.id === targetId) || p.targets[0])
  return store.decryptText(t && t.dataSync && t.dataSync.importSecret)
}

function persistAll(projects) {
  fs.mkdirSync(path.dirname(file()), { recursive: true })
  fs.writeFileSync(file(), JSON.stringify({ projects }, null, 2), { encoding: 'utf8', mode: 0o600 })
}

/**
 * 按目标合并凭据（与 AI Key 相同规则）：
 *   - 传入 secret 非空 → 加密替换；空且未要求清除 → 保留该目标既有；clearSecret → 清除
 *   - passphrase 同理
 */
function mergeSecret(s, oldSecret, key, clearKey) {
  const plain = s[key] || ''
  delete s[key]
  const clearFlag = s[clearKey]
  delete s[clearKey]
  if (plain) {
    s[key] = store.encryptText(plain)
  } else if (clearFlag) {
    delete s[key]
  } else if (oldSecret) {
    s[key] = oldSecret // 字节原样保留，不触发解密
  }
}

/**
 * 保存项目（新增或更新）。targets 为完整数组，按 id 匹配旧目标保留凭据。
 */
function save(input) {
  const projects = loadAllRaw()
  const incoming = normalizeProject(JSON.parse(JSON.stringify(input || {})))
  if (!incoming.id) incoming.id = genId()
  if (!incoming.createdAt) incoming.createdAt = Date.now()
  incoming.updatedAt = Date.now()

  const idx = projects.findIndex((p) => p.id === incoming.id)
  const old = idx >= 0 ? projects[idx] : null

  incoming.targets = incoming.targets.map((t) => {
    const oldT = old && old.targets.find((x) => x.id === t.id)
    mergeSecret(t.server, oldT && oldT.server && oldT.server.secret, 'secret', 'clearSecret')
    mergeSecret(t.server, oldT && oldT.server && oldT.server.passphrase, 'passphrase', 'clearPassphrase')
    // 数据同步导入凭据：与 server.secret 同一合并规则
    if (t.dataSync) {
      mergeSecret(t.dataSync, oldT && oldT.dataSync && oldT.dataSync.importSecret, 'importSecret', 'clearImportSecret')
    }
    return t
  })

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

module.exports = { list, save, remove, getCredentials, getDataSyncCredentials, defaultProject, defaultTarget, normalizeProject }
