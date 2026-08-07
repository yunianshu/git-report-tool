/**
 * AI 服务 —— 调用 OpenAI 兼容的 /chat/completions 接口（流式）
 * 兼容 OpenAI / DeepSeek / Moonshot(Kimi) / 通义千问 / Ollama 等提供方
 * 统一走主进程（net.fetch），规避渲染层 CORS；API Key 由主进程解析，不下发渲染层
 */
const { net } = require('electron')

const DEFAULT_BASE_URL = 'https://api.openai.com/v1'
/** 输出 token 上限（防止长报告溢出上下文或静默截断） */
const DEFAULT_MAX_TOKENS = 4096

/** 校验接口地址：仅允许 https，或 http 限本机（Ollama 本地服务） */
function assertSafeBaseUrl(baseUrl) {
  let u
  try {
    u = new URL(baseUrl || DEFAULT_BASE_URL)
  } catch {
    throw new Error('接口地址格式不正确，请检查「设置 → AI 模型 → 接口地址」')
  }
  const local = ['localhost', '127.0.0.1', '::1'].includes(u.hostname)
  const ok = u.protocol === 'https:' || (u.protocol === 'http:' && local)
  if (!ok) {
    throw new Error('接口地址仅支持 https，http 仅允许本机（localhost / 127.0.0.1）')
  }
  return `${u.protocol}//${u.host}`
}

/**
 * 流式对话。onDelta 回调收到累计文本（幂等）；返回完整回复文本。
 * 出错时抛 Error（message 可直接展示给用户）。
 */
async function chat({ baseUrl, apiKey, model, messages, temperature = 0.7, maxTokens = DEFAULT_MAX_TOKENS, onDelta, signal }) {
  if (!apiKey) throw new Error('未配置 API Key，请先在「设置 → AI 模型」中填写')
  if (!model) throw new Error('未配置模型名称，请先在「设置 → AI 模型」中填写')
  if (!Array.isArray(messages) || !messages.length) throw new Error('消息列表为空')

  const url = `${assertSafeBaseUrl(baseUrl)}/chat/completions`
  const resp = await net.fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens, stream: true }),
    signal,
  })

  if (!resp.ok) {
    let detail = ''
    try {
      detail = (await resp.text()).slice(0, 400)
    } catch { /* noop */ }
    const err = new Error(`AI 接口请求失败（HTTP ${resp.status}）${detail ? `：${detail}` : ''}`)
    err.status = resp.status
    throw err
  }

  const reader = resp.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  let full = ''

  /** 解析一段 SSE 文本（data: {...} / data: [DONE]），返回是否遇到结束 */
  const parseEvent = (data) => {
    for (const line of String(data).split('\n')) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const payload = trimmed.slice(5).trim()
      if (payload === '[DONE]') return true
      try {
        const json = JSON.parse(payload)
        const delta = json.choices?.[0]?.delta?.content || ''
        if (delta) {
          full += delta
          if (onDelta) onDelta(full)
        }
      } catch { /* 忽略无法解析的帧（如 keep-alive） */ }
    }
    return false
  }

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    // 归一化 CRLF，兼容部分服务器的 \r\n 分帧
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
    const events = buffer.split('\n\n')
    buffer = events.pop()
    for (const ev of events) {
      if (parseEvent(ev)) return full
    }
  }
  // 流结束：刷新残留缓冲（部分服务关闭时无结尾空行）
  if (buffer.trim()) parseEvent(buffer)
  return full
}

/** 测试连接：极简请求验证 baseUrl / apiKey / model 可用性 */
async function test({ baseUrl, apiKey, model }) {
  const text = await chat({
    baseUrl,
    apiKey,
    model,
    messages: [{ role: 'user', content: '你好，请只回复两个字：成功' }],
    temperature: 0,
    maxTokens: 16,
  })
  return { ok: true, reply: (text || '').trim() || '(空回复)' }
}

module.exports = { chat, test, DEFAULT_BASE_URL, DEFAULT_MAX_TOKENS }
