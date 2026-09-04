<template>
  <div class="chat-panel">
    <div class="chat-panel-header">
      <div class="model-state">
        <span class="model-dot" :class="{ ready: configured }" />
        <span>{{ configured ? modelLabel : 'AI 模型未配置' }}</span>
      </div>
      <div class="chat-panel-actions">
        <el-switch v-model="attachContext" size="small" active-text="附带项目上下文" :disabled="!contextText" />
        <el-button text type="danger" :disabled="!state.chat.messages.length" @click="clearChat"><el-icon><Delete /></el-icon>清空</el-button>
      </div>
    </div>

    <div v-if="quickPrompts.length" class="quick-prompts">
      <span>快捷开始</span>
      <el-button v-for="item in quickPrompts" :key="item.label" plain :disabled="!configured || state.chat.streaming" @click="send(item.prompt)">
        {{ item.label }}
      </el-button>
    </div>

    <div ref="scrollEl" class="chat-messages">
      <div v-if="!state.chat.messages.length" class="chat-welcome">
        <span class="welcome-index">AI / PROJECT</span>
        <h2>从项目本身开始，而不只是 Git 提交</h2>
        <p>你可以让我梳理项目目标、识别风险、安排下一步，或结合右侧已选择的上下文生成报告。</p>
      </div>

      <div v-for="(message, index) in state.chat.messages" :key="index" :class="['message-row', message.role]">
        <div class="message-role">{{ message.role === 'assistant' ? 'AI' : '你' }}</div>
        <div class="message-content">
          <div v-if="message.role === 'assistant' && message.content" class="markdown-body" v-html="renderMarkdown(message.content)" />
          <div v-else-if="message.role === 'user'" class="message-text">{{ message.content }}</div>
          <div v-else class="typing-indicator"><span /><span /><span /></div>
          <div v-if="message.role === 'assistant' && message.content && !state.chat.streaming" class="message-tools">
            <el-button text size="small" @click="copyText(message.content)"><el-icon><CopyDocument /></el-icon>复制</el-button>
            <el-button text size="small" @click="saveToFile(message.content)"><el-icon><Download /></el-icon>保存</el-button>
          </div>
        </div>
      </div>
    </div>

    <div class="composer">
      <el-input
        v-model="draft" type="textarea" :rows="3" resize="none"
        placeholder="输入关于当前项目的问题…（Enter 发送，Shift+Enter 换行）"
        :disabled="state.chat.streaming" @keydown="onKeydown"
      />
      <div class="composer-footer">
        <span class="context-budget">
          <template v-if="attachContext && contextText">{{ contextLabel }} · 约 {{ contextTokens }} tokens</template>
          <template v-else>未附带项目上下文</template>
        </span>
        <el-button v-if="state.chat.streaming" type="danger" @click="stopGen"><el-icon><VideoPause /></el-icon>停止</el-button>
        <el-button v-else type="primary" :disabled="!draft.trim() || !configured" @click="send()"><el-icon><Promotion /></el-icon>发送</el-button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { state } from '../store'
import { estimateTokens, systemPrompt, windowHistory } from '../utils/ai-context'
import { toPlain } from '../utils/ipc'

marked.setOptions({ gfm: true, breaks: true })
const props = defineProps({
  contextText: { type: String, default: '' },
  contextLabel: { type: String, default: '项目上下文' },
  quickPrompts: { type: Array, default: () => [] },
})
const TOTAL_BUDGET_CHARS = 20000
const draft = ref('')
const attachContext = ref(true)
const scrollEl = ref(null)
let unsubDelta = null

const configured = computed(() => !!(state.config.ai?.keyConfigured && state.config.ai?.model))
const modelLabel = computed(() => state.config.ai?.model || '')
const contextTokens = computed(() => estimateTokens(props.contextText))

async function scrollToEnd() {
  await nextTick()
  if (scrollEl.value) scrollEl.value.scrollTop = scrollEl.value.scrollHeight
}
watch(() => state.chat.messages.length, scrollToEnd)
watch(() => state.chat.streaming, scrollToEnd)

unsubDelta = window.gitReport?.onAiDelta?.((full) => {
  const last = state.chat.messages[state.chat.messages.length - 1]
  if (last?.role === 'assistant') last.content = full
})
onBeforeUnmount(() => unsubDelta?.())

function renderMarkdown(text) {
  const parsed = marked.parse(text || '', { async: false })
  return DOMPurify.sanitize(typeof parsed === 'string' ? parsed : String(parsed))
}

function buildApiMessages() {
  const messages = [{ role: 'system', content: systemPrompt() }]
  if (attachContext.value && props.contextText) messages.push({ role: 'system', content: props.contextText })
  const history = windowHistory(state.chat.messages.filter((item) => item.content))
  let used = messages.reduce((sum, item) => sum + item.content.length, 0)
  const kept = []
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const item = history[index]
    const remaining = TOTAL_BUDGET_CHARS - used
    if (remaining <= 0) break
    if (item.content.length <= remaining) {
      kept.unshift(item)
      used += item.content.length
    } else if (!kept.length) {
      kept.unshift({ ...item, content: `${item.content.slice(0, remaining)}…` })
    }
  }
  return [...messages, ...kept]
}

async function send(value) {
  const question = (typeof value === 'string' ? value : draft.value).trim()
  if (!question || state.chat.streaming) return
  if (!configured.value) {
    ElMessage.warning('请先在“设置 → AI 服务”配置模型')
    return
  }
  draft.value = ''
  state.chat.messages.push({ role: 'user', content: question })
  state.chat.messages.push({ role: 'assistant', content: '' })
  state.chat.streaming = true
  try {
    const result = await window.gitReport.aiChat(toPlain(buildApiMessages()), toPlain({
      baseUrl: state.config.ai?.baseUrl,
      model: state.config.ai?.model,
      temperature: state.config.ai?.temperature ?? 0.7,
    }))
    const last = state.chat.messages[state.chat.messages.length - 1]
    if (last?.role === 'assistant') {
      if (result?.ok) last.content = result.text
      else if (result?.aborted) last.content ||= '已停止生成'
      else last.content = `请求失败：${result?.error || '请检查模型配置或网络'}`
    }
  } catch (error) {
    const last = state.chat.messages[state.chat.messages.length - 1]
    if (last?.role === 'assistant') last.content = `请求失败：${error?.message || '未知错误'}`
  } finally {
    state.chat.streaming = false
  }
}

function stopGen() {
  window.gitReport?.aiStop?.()
}

function onKeydown(event) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    send()
  }
}

async function clearChat() {
  if (!state.chat.messages.length) return
  try {
    await ElMessageBox.confirm('确定清空当前项目对话吗？', '清空对话', { type: 'warning' })
    state.chat.messages = []
  } catch { /* 用户取消。 */ }
}

async function copyText(text) {
  await window.gitReport.copyText(text)
  ElMessage.success('已复制')
}

function deriveTitle(markdown) {
  const matched = String(markdown || '').match(/^#\s+(.+)$/m)
  return (matched?.[1] || 'AI项目记录').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60)
}

async function saveToFile(content) {
  const result = await window.gitReport.saveReport(`${deriveTitle(content)}.md`, content)
  if (result?.saved) {
    ElMessage.success(`已保存：${result.path}`)
    window.gitReport.openPath(result.path)
  } else if (result?.error) ElMessage.error(`保存失败：${result.error}`)
}

defineExpose({ send })
</script>
