<template>
  <div class="chat-panel">
    <!-- 顶部：配置状态 + 操作 -->
    <div class="chat-header">
      <div class="chat-title">
        <el-icon class="title-icon"><MagicStick /></el-icon>
        <span>AI 助手</span>
        <el-tag v-if="configured" size="small" type="success" effect="light">{{ modelLabel }}</el-tag>
        <el-tag v-else size="small" type="warning" effect="light">未配置模型</el-tag>
      </div>
      <div class="chat-actions">
        <el-tooltip content="发送消息时自动附带当前报告的提交数据，供 AI 归纳生成报告" placement="top">
          <el-switch v-model="attachContext" active-text="附带报告上下文" size="small" />
        </el-tooltip>
        <el-button size="small" text type="danger" :disabled="!state.chat.messages.length" @click="clearChat">
          <el-icon><Delete /></el-icon>清空对话
        </el-button>
      </div>
    </div>

    <!-- 快捷生成报告 -->
    <div class="chat-quick">
      <span class="quick-label">快速生成：</span>
      <el-button v-for="q in QUICK" :key="q.period" size="small" :disabled="!configured || state.chat.streaming" @click="quickGen(q.period)">
        {{ q.label }}
      </el-button>
      <span v-if="!configured" class="quick-hint">请先到「设置 → AI 模型」配置模型</span>
    </div>

    <!-- 消息区 -->
    <div ref="scrollEl" class="chat-messages">
      <div v-if="!state.chat.messages.length" class="chat-empty">
        <el-icon><ChatLineRound /></el-icon>
        <p>我是 AI 报告助手。点击上方按钮可一键生成日报 / 周报 / 双周报 / 月报，或直接描述你的需求。</p>
      </div>

      <div v-for="(m, i) in state.chat.messages" :key="i" :class="['msg', m.role]">
        <div class="msg-avatar">
          <el-icon v-if="m.role === 'assistant'"><MagicStick /></el-icon>
          <el-icon v-else><User /></el-icon>
        </div>
        <div class="msg-body">
          <div v-if="m.role === 'assistant'" class="md-body" v-html="renderMarkdown(m.content)" />
          <div v-else class="msg-text">{{ m.content }}</div>
          <div v-if="m.role === 'assistant' && m.content && !state.chat.streaming" class="msg-tools">
            <el-button size="small" text type="primary" @click="copyText(m.content)">
              <el-icon><CopyDocument /></el-icon>复制
            </el-button>
            <el-button size="small" text type="success" @click="saveToFile(m.content)">
              <el-icon><Download /></el-icon>保存为文件
            </el-button>
          </div>
        </div>
      </div>

      <!-- 流式进行中 -->
      <div v-if="state.chat.streaming" class="msg assistant">
        <div class="msg-avatar"><el-icon><MagicStick /></el-icon></div>
        <div class="msg-body">
          <div v-if="isLastAssistantEmpty" class="typing"><span /><span /><span /></div>
          <div v-else class="streaming-hint">
            <el-icon class="is-loading"><Loading /></el-icon>
            <span>正在生成…</span>
            <el-button size="small" text type="danger" @click="stopGen">停止</el-button>
          </div>
        </div>
      </div>
    </div>

    <!-- 输入区 -->
    <div class="chat-input">
      <el-input
        v-model="draft"
        type="textarea"
        :rows="2"
        resize="none"
        placeholder="描述需求，或点击上方按钮生成报告（Enter 发送，Shift+Enter 换行）"
        :disabled="state.chat.streaming"
        @keydown="onKeydown"
      />
      <div class="input-bar">
        <span v-if="attachContext" class="ctx-tokens">
          <el-icon><Document /></el-icon>
          <template v-if="hasContext">报告上下文约 {{ contextTokens }} tokens</template>
          <template v-else>报告上下文：无提交数据</template>
        </span>
        <el-button v-if="state.chat.streaming" type="danger" @click="stopGen">
          <el-icon><VideoPause /></el-icon>停止
        </el-button>
        <el-button v-else type="primary" :disabled="!draft.trim() || !configured" @click="send">
          <el-icon><Promotion /></el-icon>发送
        </el-button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, nextTick, watch, onBeforeUnmount } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { state } from '../store'
import { buildReportContext, systemPrompt, windowHistory, estimateTokens } from '../utils/ai-context'
import { collectReportData } from '../utils/report-data'
import { toPlain } from '../utils/ipc'

marked.setOptions({ gfm: true, breaks: true })

const props = defineProps({
  /** 报告上下文：{ rangeLabel, onlyMine, authorFilter, identities, commits, range } */
  context: { type: Object, default: () => ({}) },
})

const QUICK = [
  { label: '生成日报', period: '日报' },
  { label: '生成周报', period: '周报' },
  { label: '生成双周报', period: '双周报' },
  { label: '生成月报', period: '月报' },
]

/** 每次请求的总字符预算（系统提示 + 上下文 + 历史，约合 14k tokens） */
const TOTAL_BUDGET_CHARS = 18000

const draft = ref('')
const attachContext = ref(true)
const scrollEl = ref(null)
let unsubDelta = null

const configured = computed(() => !!(state.config.ai?.keyConfigured && state.config.ai?.model))
const modelLabel = computed(() => state.config.ai?.model || '')
const commits = computed(() => props.context?.commits || [])
const hasContext = computed(() => commits.value.length > 0)

/** 流式期间最后一条 assistant 是否仍为空占位（用于切换打字指示） */
const isLastAssistantEmpty = computed(() => {
  const last = state.chat.messages[state.chat.messages.length - 1]
  return !!(state.chat.streaming && last && last.role === 'assistant' && !last.content)
})

const contextTokens = computed(() => {
  if (!hasContext.value) return 0
  return estimateTokens(buildReportContext({
    commits: commits.value,
    rangeLabel: props.context?.rangeLabel,
    onlyMine: props.context?.onlyMine,
    authorFilter: props.context?.authorFilter,
    identities: props.context?.identities,
  }))
})

watch(() => state.chat.messages.length, async () => {
  await nextTick()
  if (scrollEl.value) scrollEl.value.scrollTop = scrollEl.value.scrollHeight
})
watch(() => state.chat.streaming, async (s) => {
  if (s) await nextTick()
  if (scrollEl.value) scrollEl.value.scrollTop = scrollEl.value.scrollHeight
})

/** 注册流式增量订阅：全量文本幂等覆盖最后一条 assistant 消息 */
unsubDelta = window.gitReport?.onAiDelta?.((full) => {
  const last = state.chat.messages[state.chat.messages.length - 1]
  if (last && last.role === 'assistant') last.content = full
})
onBeforeUnmount(() => {
  if (unsubDelta) {
    unsubDelta()
    unsubDelta = null
  }
})

function renderMarkdown(text) {
  if (!text) return ''
  const parsed = marked.parse(text, { async: false })
  return DOMPurify.sanitize(typeof parsed === 'string' ? parsed : String(parsed))
}

/** 组装请求参数：明文 API Key 由主进程从 store 解析，渲染层不发送 */
function aiOpts() {
  return {
    baseUrl: state.config.ai?.baseUrl,
    model: state.config.ai?.model,
    temperature: state.config.ai?.temperature ?? 0.7,
  }
}

/**
 * 组装发给模型的消息：系统提示 → 报告上下文（含空状态）→ 预算内历史窗口。
 * 总预算超限时：从最新消息往前保留，旧消息丢弃；若单条最新消息超限则截断。
 */
function buildApiMessages() {
  const msgs = [{ role: 'system', content: systemPrompt() }]
  if (attachContext.value) {
    msgs.push({ role: 'system', content: buildReportContext({
      commits: commits.value,
      rangeLabel: props.context?.rangeLabel,
      onlyMine: props.context?.onlyMine,
      authorFilter: props.context?.authorFilter,
      identities: props.context?.identities,
    }) })
  }
  const history = windowHistory(state.chat.messages.filter((m) => !(m.role === 'assistant' && !m.content)))
  let used = msgs.reduce((n, m) => n + (m.content?.length || 0), 0)
  const kept = []
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const m = history[i]
    const len = (m.content || '').length
    const remaining = TOTAL_BUDGET_CHARS - used
    if (remaining <= 0) break
    if (len <= remaining) {
      kept.unshift(m)
      used += len
    } else if (!kept.length) {
      // 最新一条超预算：截断保留（保住最近对话）
      kept.unshift({ ...m, content: `${(m.content || '').slice(0, remaining)}…` })
      used += remaining
    }
    // 更旧的超预算消息直接丢弃
  }
  return [...msgs, ...kept]
}

async function send(text) {
  const question = (typeof text === 'string' ? text : draft.value).trim()
  if (!question || state.chat.streaming) return
  if (!configured.value) {
    ElMessage.warning('请先在「设置 → AI 模型」配置 API Key 与模型')
    return
  }
  draft.value = ''
  state.chat.messages.push({ role: 'user', content: question })
  state.chat.messages.push({ role: 'assistant', content: '' })
  state.chat.streaming = true
  const apiMessages = buildApiMessages()
  try {
    const res = await window.gitReport.aiChat(toPlain(apiMessages), toPlain(aiOpts()))
    const last = state.chat.messages[state.chat.messages.length - 1]
    if (last && last.role === 'assistant') {
      if (res?.ok) {
        last.content = res.text
      } else if (res?.aborted) {
        if (!last.content) last.content = '⏹ 已停止生成'
      } else {
        last.content = `⚠️ ${res?.error || '请求失败，请检查模型配置或网络'}`
      }
    }
  } catch (e) {
    const last = state.chat.messages[state.chat.messages.length - 1]
    if (last && last.role === 'assistant') last.content = `⚠️ ${(e && e.message) || '请求失败'}`
  } finally {
    state.chat.streaming = false
  }
}

function stopGen() {
  window.gitReport?.aiStop?.()
}

/** 快捷生成：无提交数据时先收集当前范围，再让 AI 生成 */
async function quickGen(period) {
  if (state.chat.streaming) return
  if (!commits.value.length) {
    await collectReportData(props.context?.range || {})
  }
  send(`请根据当前报告上下文，生成一份规范的${period}（Markdown 格式）。要求：按项目分组列出提交，并补充工作小结与下一步计划。`)
}

function onKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    send()
  }
}

/** 供父视图（主页/报告页）调用：收集数据后按指定周期生成报告 */
defineExpose({ quickGen, send })

async function clearChat() {
  if (!state.chat.messages.length) return
  try {
    await ElMessageBox.confirm('确定清空当前对话吗？', '清空对话', { type: 'warning' })
  } catch {
    return
  }
  state.chat.messages = []
}

async function copyText(text) {
  try {
    await window.gitReport.copyText(text)
    ElMessage.success('已复制到剪贴板')
  } catch (e) {
    console.error('复制失败', e)
  }
}

/** 从 Markdown 首行标题推导文件名 */
function deriveTitle(md) {
  const m = String(md || '').match(/^#\s+(.+)$/m)
  const base = m ? m[1].trim() : 'AI报告'
  return base.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60)
}

/** 将 AI 生成的内容保存为 Markdown 文件 */
async function saveToFile(content) {
  if (!content) return
  const res = await window.gitReport.saveReport(`${deriveTitle(content)}.md`, content)
  if (res?.saved) {
    ElMessage.success(`已保存：${res.path}`)
    window.gitReport.openPath(res.path)
  } else if (res?.error) {
    ElMessage.error(`保存失败：${res.error}`)
  }
}
</script>

<style scoped>
.chat-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  gap: 12px;
}
.chat-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
}
.chat-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
  color: var(--brand-text);
}
.title-icon { color: var(--brand-accent); font-size: 16px; }
.chat-actions { display: flex; align-items: center; gap: 12px; }
.chat-quick {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.quick-label { font-size: 12px; color: var(--brand-text-sub); }
.quick-hint { font-size: 12px; color: #c0a23a; }

.chat-messages {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  background: #fff;
  border: 1px solid var(--brand-card-border);
  border-radius: 10px;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.chat-empty {
  margin: auto;
  text-align: center;
  color: var(--brand-text-sub);
  max-width: 380px;
}
.chat-empty .el-icon { font-size: 34px; color: #c9ced8; }
.chat-empty p { margin-top: 10px; font-size: 13px; line-height: 1.7; }

.msg { display: flex; gap: 10px; }
/* 用户消息：头像在右，气泡贴右（微信式）；AI 消息头像在左 */
.msg.user { flex-direction: row-reverse; }
.msg-avatar {
  width: 30px;
  height: 30px;
  border-radius: 8px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 15px;
}
.msg.user .msg-avatar { background: var(--el-color-primary-light-9); color: var(--brand-accent); }
.msg.assistant .msg-avatar { background: #eef0f4; color: #5d6472; }
.msg-body { min-width: 0; flex: 1; }
.msg.user .msg-body { text-align: right; }
.msg-text {
  display: inline-block;
  background: var(--el-color-primary-light-9);
  color: #23403b;
  border-radius: 10px;
  padding: 8px 12px;
  font-size: 13px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  text-align: left;
  max-width: 78%;
}
.msg-tools { margin-top: 4px; display: flex; align-items: center; gap: 2px; }

/* 流式打字指示 */
.typing { display: inline-flex; gap: 5px; padding: 6px 4px; }
.typing span {
  width: 7px; height: 7px; border-radius: 50%;
  background: #b7d7d3;
  animation: blink 1.2s infinite ease-in-out;
}
.typing span:nth-child(2) { animation-delay: .2s; }
.typing span:nth-child(3) { animation-delay: .4s; }
@keyframes blink { 0%, 60%, 100% { opacity: .3; transform: translateY(0); } 30% { opacity: 1; transform: translateY(-3px); } }
.streaming-hint {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--brand-text-sub);
}

/* Markdown 渲染 */
.md-body {
  background: #fafbfc;
  border: 1px solid var(--brand-card-border);
  border-radius: 10px;
  padding: 12px 14px;
  font-size: 13px;
  line-height: 1.7;
  color: #3a4150;
  word-break: break-word;
}
.md-body :deep(h1) { font-size: 16px; margin: 8px 0 6px; color: var(--brand-text); }
.md-body :deep(h2) { font-size: 14px; margin: 8px 0 4px; color: var(--brand-text); }
.md-body :deep(h3) { font-size: 13.5px; margin: 8px 0 4px; color: var(--brand-text); }
.md-body :deep(p) { margin: 6px 0; }
.md-body :deep(ul), .md-body :deep(ol) { margin: 6px 0; padding-left: 22px; }
.md-body :deep(li) { margin: 3px 0; }
.md-body :deep(strong) { color: var(--brand-text); }
.md-body :deep(code) {
  background: #eef1f5; border-radius: 4px; padding: 1px 5px;
  font-family: var(--brand-mono); font-size: 12px;
}
.md-body :deep(pre) {
  background: #f2f4f7; border-radius: 6px; padding: 10px;
  overflow-x: auto;
}
.md-body :deep(pre code) { background: transparent; padding: 0; }
.md-body :deep(blockquote) {
  margin: 6px 0; padding: 2px 12px;
  border-left: 3px solid var(--brand-accent);
  color: var(--brand-text-sub);
}
.md-body :deep(a) { color: var(--brand-accent); }

/* 输入区 */
.chat-input {
  background: #fff;
  border: 1px solid var(--brand-card-border);
  border-radius: 10px;
  padding: 10px;
}
.chat-input :deep(.el-textarea__inner) { box-shadow: none !important; }
.input-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 8px;
}
.ctx-tokens {
  font-size: 11.5px;
  color: var(--brand-text-sub);
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-family: var(--brand-mono);
}
</style>
