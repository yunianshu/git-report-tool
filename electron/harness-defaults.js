/**
 * 内置 Harness 默认配置 —— 随安装包分发 provider 与默认模型
 *
 * 目标：目标机器装完软件、首次启动 Harness 时，模型选择器里就有汉印（内网）
 * 与智谱的 provider，不必逐个手工添加。
 *
 * 边界（重要）：
 * - **不含任何密钥**：provider 用 `apiKeyEnv` 引用凭据名，使用者在 Harness 界面
 *   填入自己的 key；本文件只出现凭据名，不出现凭据值。
 * - **不覆盖用户配置**：只补缺失的 provider 与默认模型，同名项保持原值。
 * - **一次性注入**：成功后写标记文件，之后启动不再改动，尊重用户后续增删。
 * - **解析失败不动原文件**：宁可跳过，也不破坏用户的 settings.yaml。
 *
 * 写入的是 dsh 的 `<DSH_HOME>/settings.yaml`，用 yaml 的 Document API 做
 * 叶子级 setIn，保留用户已有的注释与格式。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { parseDocument } = require('yaml')

/** 注入标记：存在即表示已注入过，不再改动用户的 settings.yaml */
const MARKER_NAME = '.project-tool-defaults.json'
const MARKER_VERSION = 1

/**
 * 内置 provider 定义（与 dsh-llm-pi-ai 的 provider schema 对齐）。
 * 凭据通过 `apiKeyEnv` 引用名字，值由使用者在界面填入。
 */
const DEFAULT_PROVIDERS = {
  'zai-coding-cn': {
    models: [
      { id: 'glm-4.5-air', name: 'GLM-4.5-Air', contextWindow: 131072, maxTokens: 98304 },
      { id: 'glm-4.7', name: 'GLM-4.7', contextWindow: 204800, maxTokens: 131072 },
      { id: 'glm-5-turbo', name: 'GLM-5-Turbo', contextWindow: 200000, maxTokens: 131072 },
      { id: 'glm-5.1', name: 'GLM-5.1', contextWindow: 200000, maxTokens: 131072 },
      { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 1000000, maxTokens: 131072 },
      { id: 'glm-5v-turbo', name: 'GLM-5V-Turbo', contextWindow: 200000, maxTokens: 131072 },
    ],
    apiKeyEnv: 'ZAI_CODING_CN_API_KEY',
    reasoning: 'high',
  },
  hprt: {
    displayName: '汉印',
    apiKeyEnv: 'HPRT_API_KEY',
    api: 'openai-completions',
    baseURL: 'http://ai.sysapp.prttech.com:18080/v1',
    models: [
      {
        id: 'deepseek-v4.1-flash-expires-on-0910',
        name: 'deepseek-v4.1-flash',
        contextWindow: 1000000,
        maxTokens: 128000,
      },
    ],
  },
}

/** 默认模型：与内置 provider 一起写入，用户已有配置时不覆盖 */
const DEFAULT_AGENT_MODEL = { provider: 'hprt', model: 'deepseek-v4.1-flash-expires-on-0910' }

/** Harness 主目录（与 harness-service 的 homeDir 保持同一规则：$DSH_HOME 优先） */
function homeDir() {
  return (process.env.DSH_HOME || '').trim() || path.join(os.homedir(), '.dsh')
}

function markerPath(home) {
  return path.join(home, MARKER_NAME)
}

/** 读取注入标记；不存在或版本不符返回 null */
function readMarker(home) {
  try {
    const parsed = JSON.parse(fs.readFileSync(markerPath(home), 'utf8'))
    return parsed && parsed.version === MARKER_VERSION ? parsed : null
  } catch { return null }
}

/**
 * 把内置 provider 与默认模型补进 `<DSH_HOME>/settings.yaml`。
 *
 * @param {{home?: string}} [options] 可指定 home（测试用），默认取 $DSH_HOME / ~/.dsh
 * @returns {{changed: boolean, injected: string[], reason: string, file: string, home: string}}
 *   changed 表示本次是否写入；reason 为 skipped 原因（already-injected / parse-failed / read-failed）
 */
function ensureDefaultSettings(options = {}) {
  const home = (options.home || homeDir()).trim()
  const file = path.join(home, 'settings.yaml')
  const result = { changed: false, injected: [], reason: '', file, home }

  if (!home) { result.reason = 'no-home'; return result }
  if (readMarker(home)) { result.reason = 'already-injected'; return result }

  let text = ''
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    // 文件缺失是正常情况（全新机器首次启动）；其余读取错误直接放弃
    if (!err || err.code !== 'ENOENT') { result.reason = `read-failed:${(err && err.code) || 'unknown'}`; return result }
  }

  let doc
  try {
    doc = parseDocument(text)
    if (doc.errors && doc.errors.length) throw doc.errors[0]
  } catch (err) {
    // 用户手工编辑出错时不接管：保持原文件，下次启动再试
    result.reason = `parse-failed:${(err && err.message) || String(err)}`
    return result
  }

  for (const [id, definition] of Object.entries(DEFAULT_PROVIDERS)) {
    if (doc.hasIn(['llm-pi-ai', 'providers', id])) continue
    doc.setIn(['llm-pi-ai', 'providers', id], definition)
    result.injected.push(`llm-pi-ai.providers.${id}`)
  }
  if (!doc.hasIn(['agent-default-model', 'provider'])) {
    doc.setIn(['agent-default-model'], DEFAULT_AGENT_MODEL)
    result.injected.push('agent-default-model')
  }

  try {
    fs.mkdirSync(home, { recursive: true })
    if (result.injected.length) {
      // 原子写：临时文件 + rename，避免与正在运行的 dsh 读到半截文档
      const tmp = `${file}.project-tool.tmp`
      fs.writeFileSync(tmp, doc.toString(), { encoding: 'utf8', mode: 0o600 })
      fs.renameSync(tmp, file)
      result.changed = true
    }
    fs.writeFileSync(markerPath(home), JSON.stringify({
      version: MARKER_VERSION,
      injectedAt: new Date().toISOString(),
      injected: result.injected,
    }, null, 2), { encoding: 'utf8', mode: 0o600 })
  } catch (err) {
    result.reason = `write-failed:${(err && err.message) || String(err)}`
    return result
  }

  return result
}

module.exports = {
  ensureDefaultSettings,
  homeDir,
  markerPath,
  DEFAULT_PROVIDERS,
  DEFAULT_AGENT_MODEL,
  MARKER_NAME,
  MARKER_VERSION,
}
