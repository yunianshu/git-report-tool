<template>
  <div class="chat-view">
    <!-- 顶部工具条：选周期 → 一键让 AI 生成（主页即聊天） -->
    <el-card shadow="never" class="card chat-toolbar-card">
      <div class="chat-toolbar">
        <div class="toolbar-left">
          <el-radio-group v-model="period">
            <el-radio-button value="daily">日报</el-radio-button>
            <el-radio-button value="weekly">周报</el-radio-button>
            <el-radio-button value="biweekly">双周报</el-radio-button>
            <el-radio-button value="monthly">月报</el-radio-button>
          </el-radio-group>
          <el-date-picker v-if="period === 'daily'" v-model="dailyDate" type="date" value-format="YYYY-MM-DD" />
          <el-switch v-model="onlyMine" active-text="只看本人" inactive-text="全部作者" class="mine-switch" />
        </div>
        <div class="toolbar-right">
          <span class="repo-count">{{ state.discoveredRepos.length }} 个仓库</span>
          <el-button type="primary" size="large" :loading="busy" :disabled="busy || state.chat.streaming" @click="genReport">
            <el-icon style="margin-right: 4px"><MagicStick /></el-icon>AI 生成报告
          </el-button>
        </div>
      </div>
      <el-alert
        v-if="!state.config.roots.length"
        type="warning"
        :closable="false"
        title="尚未配置扫描根目录，请到「设置」页添加后再生成报告。"
        class="warn"
      />
    </el-card>

    <!-- 扫描/收集进度 -->
    <div v-if="collecting" class="phase-card">
      <el-icon class="is-loading phase-icon"><Loading /></el-icon>
      <div class="phase-text">
        <div class="phase-title">{{ phaseTitle }}</div>
        <div class="phase-detail">{{ phaseDetail }}</div>
      </div>
      <el-progress v-if="state.report.collectProgress?.total" :percentage="collectPercent" :stroke-width="5" class="phase-bar" />
    </div>

    <!-- 聊天主页 -->
    <div class="chat-body">
      <ChatPanel ref="chatPanel" :context="chatContext" />
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { ElMessage } from 'element-plus'
import { state } from '../store'
import { todayStr, addDays, untilToEnd } from '../utils/date'
import ChatPanel from '../components/ChatPanel.vue'

const period = ref('daily')
const dailyDate = ref(todayStr())
const onlyMine = ref(true)
const chatPanel = ref(null)

/** 当前周期的 git 查询范围（until 为排他语义） */
const range = computed(() => {
  const T = todayStr()
  if (period.value === 'daily') return { since: dailyDate.value, until: addDays(dailyDate.value, 1) }
  if (period.value === 'weekly') return { since: addDays(T, -6), until: addDays(T, 1) }
  if (period.value === 'biweekly') return { since: addDays(T, -13), until: addDays(T, 1) }
  if (period.value === 'monthly') return { since: addDays(T, -29), until: addDays(T, 1) }
  return { since: addDays(T, -6), until: addDays(T, 1) }
})
const rangeLabel = computed(() => {
  const r = range.value
  const end = untilToEnd(r.until) || r.since
  return r.since === end ? r.since : `${r.since} ~ ${end}`
})

const collecting = computed(() => state.report.phase === 'scanning' || state.report.phase === 'collecting')
const busy = computed(() => collecting.value)
const phaseTitle = computed(() => (state.report.phase === 'scanning' ? '正在扫描仓库' : '正在收集提交'))
const phaseDetail = computed(() => {
  if (state.report.phase === 'scanning') {
    return `已处理 ${state.report.scanProgress?.scanned || 0} 个目录 · 已发现 ${state.discoveredRepos.length} 个仓库`
  }
  const t = state.report.collectProgress?.total
  return t ? `已完成 ${state.report.collectProgress?.done || 0} / ${t} 个仓库` : '正在收集提交…'
})
const collectPercent = computed(() => {
  const t = state.report.collectProgress?.total
  return t ? Math.round(((state.report.collectProgress?.done || 0) / t) * 100) : 0
})

function isMine(c) {
  const ids = state.config?.identities || []
  if (!ids.length) return false
  return ids.some((id) => (id.email && c.authorEmail === id.email) || (id.name && c.authorName === id.name))
}

/** 与「只看本人」口径一致的提交（供 AI 上下文使用） */
const filteredCommits = computed(() => state.report.rawCommits.filter((c) => (onlyMine.value ? isMine(c) : true)))

const chatContext = computed(() => ({
  rangeLabel: rangeLabel.value,
  onlyMine: onlyMine.value,
  authorFilter: [],
  identities: state.config.identities || [],
  commits: filteredCommits.value,
  range: range.value,
}))

const PERIOD_LABEL = { daily: '日报', weekly: '周报', biweekly: '双周报', monthly: '月报' }

/** 一键生成：交由聊天面板（内部自动收集数据 → 附带上下文 → 发送报告请求） */
async function genReport() {
  if (busy.value || state.chat.streaming) return
  if (!state.config.roots || !state.config.roots.length) {
    ElMessage.warning('请先到「设置」添加扫描根目录')
    return
  }
  await chatPanel.value?.quickGen(PERIOD_LABEL[period.value])
}
</script>

<style scoped>
.chat-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  gap: 14px;
}
.chat-toolbar-card { flex-shrink: 0; }
.chat-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}
.toolbar-left {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
}
.toolbar-right {
  display: flex;
  align-items: center;
  gap: 12px;
}
.repo-count {
  font-size: 13px;
  color: var(--brand-text-sub);
  font-family: var(--brand-mono);
}
.mine-switch { margin-left: 4px; }
.warn { margin-top: 10px; }

.phase-card {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 20px 24px;
  background: #fff;
  border: 1px solid var(--brand-card-border);
  border-radius: 10px;
  box-shadow: 0 1px 2px rgba(20, 30, 50, .04);
  flex-shrink: 0;
}
.phase-icon { font-size: 20px; color: var(--brand-accent); }
.phase-text { flex: 1; min-width: 0; }
.phase-title { font-size: 14px; font-weight: 600; color: var(--brand-text); }
.phase-detail { font-size: 12px; color: var(--brand-text-sub); margin-top: 4px; }
.phase-bar { width: 220px; flex-shrink: 0; }

/* 聊天主体撑满剩余空间 */
.chat-body {
  flex: 1;
  min-height: 0;
  display: flex;
}
.chat-body > * { flex: 1; min-height: 0; }
</style>
