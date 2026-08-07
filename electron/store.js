/**
 * 配置持久化 —— 读写 userData/config.json（避免引入额外依赖）
 * 安全约定：API Key 的明文只存在于主进程（load 解密后仅下发脱敏片段，
 * 明文 Key 通过 getApiKey() 供主进程调用 AI 接口使用，绝不发给渲染层）。
 */
const { app, safeStorage } = require('electron')
const fs = require('fs')
const path = require('path')

function file() {
  return path.join(app.getPath('userData'), 'config.json')
}

const DEFAULTS = {
  roots: [],
  // 默认勾选常用排除目录，减少扫描范围（与 git-service 默认排除保持一致）
  excludes: [
    'node_modules', 'FlutterSDK', 'fvm_cache', '__MACOSX', 'android-sdk',
    'androidsdk', 'jdk', 'Program Files', 'Pods', '.gradle', '.idea', '.cache',
  ],
  // 本人身份（支持多个账号）：{ name, email } 列表，「只看本人」会匹配所有账号
  identities: [],
  // AI 模型配置（API Key 经 safeStorage 加密后以 keyEnc 落盘）
  ai: {
    baseUrl: 'https://api.openai.com/v1',
    model: '',
    temperature: 0.7,
  },
}

/** 从 AI 配置对象解密出明文 Key（keyEnc 优先，兼容旧版明文 apiKey） */
function decryptKey(ai) {
  if (!ai) return ''
  if (ai.keyEnc) {
    try {
      if (safeStorage.isEncryptionAvailable()) {
        return safeStorage.decryptString(Buffer.from(ai.keyEnc, 'base64'))
      }
    } catch {
      /* 解密失败返回空，不破坏磁盘上的 keyEnc */
    }
  }
  return ai.apiKey || ''
}

function maskKey(key) {
  if (!key) return ''
  if (key.length <= 8) return '••••••'
  return `••••••${key.slice(-4)}`
}

function load() {
  try {
    const raw = fs.readFileSync(file(), 'utf8')
    const cfg = { ...DEFAULTS, ...JSON.parse(raw) }
    cfg.ai = { ...DEFAULTS.ai, ...(cfg.ai || {}) }
    const key = decryptKey(cfg.ai)
    // 明文 Key 不出主进程：仅下发「是否已配置 + 脱敏片段」
    cfg.ai.keyConfigured = !!key
    cfg.ai.keyMasked = key ? maskKey(key) : ''
    cfg.ai.apiKey = ''
    delete cfg.ai.keyEnc
    return cfg
  } catch {
    return { ...DEFAULTS, ai: { ...DEFAULTS.ai, apiKey: '', keyConfigured: false, keyMasked: '' } }
  }
}

/**
 * 保存配置。Key 规则：
 * - cfg.ai.apiKey 非空 → 用新 Key 加密替换
 * - cfg.ai.apiKey 为空  → 原样保留磁盘上既有 keyEnc（不解密，杜绝解密失败丢数据）
 * - cfg.ai.clearKey=true → 显式清除 Key
 * 平台不支持 safeStorage 时回退明文（本地工具兜底，文件设 0o600）。
 */
function save(cfg) {
  try {
    const c = JSON.parse(JSON.stringify(cfg || {}))
    if (c.ai) {
      const newKey = c.ai.apiKey || ''
      const clear = !!c.ai.clearKey
      delete c.ai.clearKey
      delete c.ai.keyConfigured
      delete c.ai.keyMasked
      delete c.ai.apiKey
      if (!clear && !newKey) {
        // 未输入新 Key 也未要求清除：保留磁盘既有 Key（字节原样，不触发解密）
        try {
          const old = JSON.parse(fs.readFileSync(file(), 'utf8'))
          const oldAi = old.ai || {}
          if (oldAi.keyEnc) c.ai.keyEnc = oldAi.keyEnc
          else if (oldAi.apiKey) c.ai.apiKey = oldAi.apiKey
        } catch { /* 无既有配置 */ }
      } else if (newKey) {
        try {
          if (safeStorage.isEncryptionAvailable()) {
            c.ai.keyEnc = safeStorage.encryptString(newKey).toString('base64')
          } else {
            c.ai.apiKey = newKey // 平台不支持加密时明文兜底
          }
        } catch {
          c.ai.apiKey = newKey
        }
      }
      // clear → 不带 keyEnc / apiKey，即清除
    }
    fs.writeFileSync(file(), JSON.stringify(c, null, 2), { encoding: 'utf8', mode: 0o600 })
    return true
  } catch {
    return false
  }
}

/** 主进程专用：返回明文 API Key（绝不发往渲染层） */
function getApiKey() {
  try {
    return decryptKey(JSON.parse(fs.readFileSync(file(), 'utf8')).ai || {})
  } catch {
    return ''
  }
}

module.exports = { load, save, getApiKey }
