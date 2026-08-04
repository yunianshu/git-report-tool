<template>
  <div class="report-page">
    <!-- 顶部工具条：选周期 → 点生成，一键完成 -->
    <el-card shadow="never" class="card report-toolbar-card">
      <div class="report-toolbar">
        <div class="toolbar-left">
          <el-radio-group v-model="period">
            <el-radio-button value="daily">日报</el-radio-button>
            <el-radio-button value="weekly">周报</el-radio-button>
            <el-radio-button value="monthly">月报</el-radio-button>
            <el-radio-button value="custom">自定义</el-radio-button>
          </el-radio-group>

          <el-date-picker
            v-if="period === 'daily'"
            v-model="dailyDate"
            type="date"
            value-format="YYYY-MM-DD"
          />
          <template v-else-if="period === 'custom'">
            <el-date-picker v-model="customSince" type="date" value-format="YYYY-MM-DD" placeholder="开始日期" />
            <span class="range-sep">至</span>
            <el-date-picker v-model="customUntil" type="date" value-format="YYYY-MM-DD" placeholder="结束日期" />
          </template>

          <el-switch v-model="onlyMine" active-text="只看本人" inactive-text="全部作者" class="mine-switch" />
        </div>
        <div class="toolbar-right">
          <span class="repo-count">{{ state.discoveredRepos.length }} 个仓库</span>
          <el-button
            type="primary"
            size="large"
            :loading="busy"
            :disabled="busy"
            @click="generate"
          >
            <el-icon style="margin-right: 4px"><MagicStick /></el-icon>生成报告
          </el-button>
        </div>
      </div>

      <!-- 全部作者时可选作者 -->
      <div v-if="!onlyMine && authors.length" class="author-filter-row">
        <el-checkbox-group v-model="authorFilter">
          <el-checkbox v-for="a in authors" :key="a.name" :value="a.name">{{ a.name }}（{{ a.count }}）</el-checkbox>
        </el-checkbox-group>
      </div>

      <el-alert
        v-if="!state.config.roots.length"
        type="warning"
        :closable="false"
        title="尚未配置扫描根目录，请到「设置」页添加后再生成报告。"
        class="warn"
      />
    </el-card>

    <!-- 生成过程：扫描 / 收集中 -->
    <div v-if="state.report.phase === 'scanning' || state.report.phase === 'collecting'" class="report-results">
      <div class="phase-card">
        <el-icon class="is-loading phase-icon"><Loading /></el-icon>
        <div class="phase-text">
          <div class="phase-title">{{ state.report.phase === 'scanning' ? '正在扫描仓库' : '正在收集提交' }}</div>
          <div class="phase-detail">
      <template v-if="state.report.phase === 'scanning'">已处理 {{ state.report.scanProgress.scanned }} 个目录 · 已发现 {{ state.discoveredRepos.length }} 个仓库</template>
      <template v-else>已完成 {{ state.report.collectProgress.done }} / {{ state.report.collectProgress.total }} 个仓库</template>
          </div>
        </div>
        <el-progress
          v-if="state.report.phase === 'collecting'"
          :percentage="collectPercent"
          :stroke-width="5"
          class="phase-bar"
        />
      </div>
    </div>

    <!-- 结果 tabs：始终显示，明细/统计仅生成后可见 -->
    <el-tabs v-model="resultTab" class="result-tabs report-tabs">
      <el-tab-pane v-if="state.report.phase === 'done'" label="报告明细" name="detail">
            <div class="detail-toolbar">
              <span class="detail-summary">{{ filteredCommits.length }} 条提交 · {{ filteredGroups.length }} 个项目</span>
              <div class="detail-actions">
                <el-button size="small" :disabled="!filteredCommits.length" @click="copyReport">
                  <el-icon style="margin-right: 4px"><CopyDocument /></el-icon>复制报告
                </el-button>
                <el-button type="success" size="small" :disabled="!filteredCommits.length" @click="exportReport">
                  <el-icon style="margin-right: 4px"><Download /></el-icon>导出 Markdown
                </el-button>
              </div>
            </div>
            <div v-if="filteredGroups.length" class="report-detail-list">
              <div v-for="g in filteredGroups" :key="g.repo" class="project-card">
                <div class="project-header">
                  <span class="project-name">{{ g.project }}</span>
                  <div class="project-right">
                    <span class="project-count">{{ g.commits.length }} 条提交</span>
                    <el-button size="small" text type="primary" @click="copyProject(g)">
                      <el-icon style="margin-right: 3px"><CopyDocument /></el-icon>复制
                    </el-button>
                  </div>
                </div>
                <div class="commit-list">
                  <div v-for="(c, i) in g.commits" :key="c.hash" class="commit-row">
                    <span class="commit-no">{{ i + 1 }}</span>
                    <span class="commit-date">{{ c.date.slice(5) }}</span>
                    <span class="commit-subject">{{ c.subject }}</span>
                  </div>
                </div>
              </div>
            </div>
            <div v-else class="collect-hint">该时间范围内无提交记录</div>
          </el-tab-pane>

          <!-- 统计分析：KPI + 图表 -->
          <el-tab-pane v-if="state.report.phase === 'done'" label="统计分析" name="stats">
            <el-row :gutter="12" class="stats">
              <el-col :span="6">
                <div class="kpi-card">
                  <div class="kpi-icon"><el-icon><List /></el-icon></div>
                  <div class="kpi-body">
                    <div class="kpi-label">提交数</div>
                    <div class="kpi-value"><CountUp :target="filteredCommits.length" /></div>
                  </div>
                </div>
              </el-col>
              <el-col :span="6">
                <div class="kpi-card">
                  <div class="kpi-icon"><el-icon><FolderOpened /></el-icon></div>
                  <div class="kpi-body">
                    <div class="kpi-label">活跃项目</div>
                    <div class="kpi-value"><CountUp :target="filteredGroups.length" /></div>
                  </div>
                </div>
              </el-col>
              <el-col :span="6">
                <div class="kpi-card">
                  <div class="kpi-icon"><el-icon><User /></el-icon></div>
                  <div class="kpi-body">
                    <div class="kpi-label">作者数</div>
                    <div class="kpi-value"><CountUp :target="authorCount" /></div>
                  </div>
                </div>
              </el-col>
              <el-col :span="6">
                <div class="kpi-card">
                  <div class="kpi-icon"><el-icon><Calendar /></el-icon></div>
                  <div class="kpi-body">
                    <div class="kpi-label">时间范围</div>
                    <div class="kpi-value kpi-range">{{ rangeLabel }}</div>
                  </div>
                </div>
              </el-col>
            </el-row>

            <el-row :gutter="12" class="charts">
              <el-col :span="12">
                <el-card shadow="never" header="项目提交分布">
                  <BaseChart :option="projectBarOption" height="300px" />
                </el-card>
              </el-col>
              <el-col :span="12">
                <el-card shadow="never" header="每日提交趋势">
                  <BaseChart :option="trendOption" height="300px" />
                </el-card>
              </el-col>
            </el-row>
          </el-tab-pane>

      <!-- 历史记录 tab（始终显示） -->
      <el-tab-pane label="历史记录" name="history">
        <el-table :data="historyList" size="small">
          <el-table-column prop="createdAt" label="生成时间" width="175" />
          <el-table-column prop="title" label="标题" min-width="220" show-overflow-tooltip />
          <el-table-column prop="commitCount" label="提交数" width="80" />
          <el-table-column prop="projectCount" label="项目数" width="80" />
          <el-table-column label="操作" width="140">
            <template #default="{ row }">
              <el-button size="small" @click="viewHistory(row)">查看</el-button>
              <el-button size="small" type="danger" plain @click="delHistory(row)">删除</el-button>
            </template>
          </el-table-column>
          <template #empty>
            <div class="table-empty">
              <el-icon><Document /></el-icon>
              <p>暂无历史记录，生成报告后会自动保存</p>
            </div>
          </template>
        </el-table>
      </el-tab-pane>
    </el-tabs>

    <!-- 空状态引导（未生成时） -->
    <div v-if="state.report.phase === 'idle'" class="report-hint">
      <el-alert type="info" :closable="false" show-icon title="选择周期后点击「生成报告」，自动扫描仓库并汇总提交" />
    </div>

    <!-- 历史报告查看 -->
    <el-dialog v-model="historyDialog.visible" :title="historyDialog.title" width="760" top="6vh">
      <pre class="history-content">{{ historyDialog.content }}</pre>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { state } from '../store'
import { todayStr, addDays, untilToEnd } from '../utils/date'
import { groupByProject, buildMarkdown, stripPrefix } from '../utils/report'
import { toPlain } from '../utils/ipc'
import { shortPath } from '../utils/path'
import BaseChart from '../components/BaseChart.vue'
import CountUp from '../components/CountUp.vue'

const period = ref('daily')
// 日报默认今天
const dailyDate = ref(todayStr())
const customSince = ref(addDays(todayStr(), -6))
const customUntil = ref(todayStr())
const onlyMine = ref(true)
const authorFilter = ref([])
const resultTab = ref('detail') // detail | stats | history
// 未生成报告时只显示历史 tab；生成完成后默认报告明细
watch(
  () => state.report.phase,
  (p) => {
    if (p === 'done') resultTab.value = 'detail'
    else resultTab.value = 'history'
  },
  { immediate: true }
)

// 历史记录
const historyList = ref([])
const historyDialog = ref({ visible: false, title: '', content: '' })
onMounted(loadHistory)

// 生成过程状态全部存于共享 store.state.report，切换视图不中断
const busy = computed(() => state.report.phase === 'scanning' || state.report.phase === 'collecting')
const collectPercent = computed(() => {
  const t = state.report.collectProgress.total
  return t ? Math.round((state.report.collectProgress.done / t) * 100) : 0
})

/** 计算 git 查询起止（until 为排他语义，= 结束日 + 1 天） */
function range() {
  const T = todayStr()
  if (period.value === 'daily') return { since: dailyDate.value, until: addDays(dailyDate.value, 1) }
  if (period.value === 'weekly') return { since: addDays(T, -6), until: addDays(T, 1) }
  if (period.value === 'monthly') return { since: addDays(T, -29), until: addDays(T, 1) }
  return {
    since: customSince.value,
    until: customUntil.value ? addDays(customUntil.value, 1) : '',
  }
}

const rangeLabel = computed(() => {
  const r = range()
  if (!r.since) return ''
  const end = untilToEnd(r.until) || r.since
  return r.since === end ? r.since : `${r.since} ~ ${end}`
})

/** 一键生成：扫描（若有需要）→ 收集提交 → 展示，分阶段显示进度 */
async function generate() {
  if (busy.value) return
  // 阶段 1：确保有仓库（自动扫描）
  if (!state.discoveredRepos.length) {
    if (!state.config.roots || !state.config.roots.length) {
      ElMessage.warning('请先到「设置」添加扫描根目录')
      return
    }
    state.report.phase = 'scanning'
    state.report.scanProgress = { scanned: 0 }
    try {
      const paths = await window.gitReport.scanRepos(toPlain(state.config.roots), toPlain(state.config.excludes))
      state.discoveredRepos = paths.map((p) => ({ path: p, shortName: shortPath(p), info: null }))
    } catch (e) {
      console.error('自动扫描失败', e)
      ElMessage.error('扫描仓库失败')
      state.report.phase = 'idle'
      return
    }
    if (!state.discoveredRepos.length) {
      ElMessage.warning('未扫描到任何 Git 仓库')
      state.report.phase = 'idle'
      return
    }
  }
  // 阶段 2：收集提交
  await doCollect()
}

async function doCollect() {
  state.report.phase = 'collecting'
  state.report.collectProgress = { done: 0, total: 0 }
  const r = range()
  try {
    const repos = state.discoveredRepos.map((row) => row.path)
    const data = await window.gitReport.collectCommits(toPlain(repos), {
      since: r.since,
      until: r.until,
      authors: [],
      includeMerges: false,
    })
    state.report.rawCommits = data
    state.report.openProjects = []
    state.report.phase = 'done'
    if (data.length) autoSave()
    if (!data.length) {
      ElMessage.warning(
        period.value === 'daily'
          ? `${dailyDate.value} 无提交记录（可改选其它日期）`
          : '所选时间范围内无提交记录'
      )
    }
  } catch (e) {
    console.error('收集失败', e)
    ElMessage.error('收集提交失败')
    state.report.phase = 'idle'
  }
}

const authors = computed(() => {
  const m = new Map()
  state.report.rawCommits.forEach((c) => {
    if (!m.has(c.authorName)) m.set(c.authorName, { name: c.authorName, email: c.authorEmail, count: 0 })
    m.get(c.authorName).count += 1
  })
  return [...m.values()].sort((a, b) => b.count - a.count)
})

function isMine(c) {
  const ids = state.config?.identities || []
  if (!ids.length) return false
  return ids.some(
    (id) => (id.email && c.authorEmail === id.email) || (id.name && c.authorName === id.name)
  )
}

const filteredCommits = computed(() =>
  state.report.rawCommits.filter((c) => {
    if (onlyMine.value) return isMine(c)
    if (authorFilter.value.length) return authorFilter.value.includes(c.authorName)
    return true
  })
)

const filteredGroups = computed(() => groupByProject(filteredCommits.value))
const authorCount = computed(() => new Set(filteredCommits.value.map((c) => c.authorName)).size)

const projectBarOption = computed(() => {
  const top = filteredGroups.value.slice(0, 12).reverse()
  return {
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    grid: { left: 30, right: 34, top: 10, bottom: 30 },
    xAxis: { type: 'value', minInterval: 1 },
    yAxis: {
      type: 'category',
      data: top.map((g) => g.project),
      axisLabel: { color: '#5d6472', fontSize: 11 },
      axisLine: { show: false },
      axisTick: { show: false },
    },
    series: [{
      type: 'bar',
      data: top.map((g) => g.commits.length),
      barMaxWidth: 20,
      itemStyle: {
        borderRadius: [0, 5, 5, 0],
        color: {
          type: 'linear', x: 0, y: 0, x2: 1, y2: 0,
          colorStops: [
            { offset: 0, color: '#0e7a6d' },
            { offset: 1, color: '#2ea68f' },
          ],
        },
      },
      label: {
        show: true,
        position: 'right',
        color: '#4a5160',
        fontSize: 11,
        fontFamily: "'IBM Plex Mono', monospace",
        fontWeight: 600,
      },
    }],
  }
})

const trendOption = computed(() => {
  const m = new Map()
  filteredCommits.value.forEach((c) => m.set(c.date, (m.get(c.date) || 0) + 1))
  const sorted = [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
  return {
    tooltip: { trigger: 'axis' },
    grid: { left: 34, right: 20, top: 24, bottom: 30 },
    xAxis: {
      type: 'category',
      data: sorted.map((e) => e[0].slice(5)),
      boundaryGap: false,
      axisLabel: { color: '#8a909c', fontSize: 10 },
      axisLine: { lineStyle: { color: '#eef0f4' } },
    },
    yAxis: {
      type: 'value',
      minInterval: 1,
      axisLabel: { color: '#8a909c', fontSize: 10 },
      splitLine: { lineStyle: { color: '#f2f4f7', type: 'dashed' } },
    },
    series: [{
      type: 'line',
      smooth: true,
      symbol: 'circle',
      symbolSize: 6,
      data: sorted.map((e) => e[1]),
      lineStyle: { width: 2.5, color: '#0e7a6d' },
      itemStyle: { color: '#0e7a6d', borderColor: '#fff', borderWidth: 2 },
      areaStyle: {
        color: {
          type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
          colorStops: [
            { offset: 0, color: 'rgba(14, 122, 109, 0.26)' },
            { offset: 1, color: 'rgba(14, 122, 109, 0.02)' },
          ],
        },
      },
    }],
  }
})

function getTitle() {
  const map = {
    daily: `项目日报 — ${dailyDate.value}`,
    weekly: `项目周报 — ${rangeLabel.value}`,
    monthly: `项目月报 — ${rangeLabel.value}`,
    custom: `项目报告 — ${rangeLabel.value}`,
  }
  return map[period.value]
}

function getMarkdown() {
  return buildMarkdown({
    title: getTitle(),
    subtitle: `数据来源：${state.discoveredRepos.length} 个 Git 仓库 · 作者：${onlyMine.value ? `本人(${(state.config.identities || []).length}个账号)` : '全部作者'}`,
    commits: filteredCommits.value,
    stats: {
      commitCount: filteredCommits.value.length,
      projectCount: filteredGroups.value.length,
      authorCount: authorCount.value,
    },
  })
}

/** 生成完成后自动保存到历史记录 */
async function autoSave() {
  try {
    await window.gitReport.saveReportAuto({
      title: getTitle(),
      content: getMarkdown(),
      period: period.value,
      dateRange: rangeLabel.value,
      commitCount: filteredCommits.value.length,
      projectCount: filteredGroups.value.length,
    })
    loadHistory()
  } catch (e) {
    console.error('自动保存历史失败', e)
  }
}

async function loadHistory() {
  try {
    historyList.value = await window.gitReport.listHistory()
  } catch { /* noop */ }
}

async function viewHistory(row) {
  const data = await window.gitReport.readHistory(row.id)
  if (data) {
    historyDialog.value = { visible: true, title: data.title, content: data.content }
  }
}

async function copyText(text) {
  try {
    await window.gitReport.copyText(text)
    ElMessage.success('已复制到剪贴板')
  } catch (e) {
    console.error('复制失败', e)
  }
}

/** 复制单个项目的提交内容（去掉日期与 feat:/fix: 等类型前缀） */
function copyProject(g) {
  const lines = [`${g.project}（${g.commits.length} 条提交）`]
  g.commits.forEach((c, i) => {
    lines.push(`${i + 1}. ${stripPrefix(c.subject)}`)
  })
  copyText(lines.join('\n'))
}

/** 复制整个报告（Markdown 全文） */
function copyReport() {
  copyText(getMarkdown())
}

async function delHistory(row) {
  try {
    await ElMessageBox.confirm('确定删除这条历史记录吗？', '删除确认', { type: 'warning' })
  } catch {
    return
  }
  await window.gitReport.deleteHistory(row.id)
  loadHistory()
}

async function exportReport() {
  const md = getMarkdown()
  const safeName = getTitle().replace(/[\\/:*?"<>|]/g, '_')
  const res = await window.gitReport.saveReport(`${safeName}.md`, md)
  if (res?.saved) {
    ElMessage.success(`已保存：${res.path}`)
    window.gitReport.openPath(res.path)
  }
}
</script>

<style scoped>
.collect-hint {
  padding: 26px 0;
  text-align: center;
  color: #909399;
  font-size: 13px;
}
.history-content {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: var(--brand-mono);
  font-size: 12.5px;
  line-height: 1.7;
  color: #3a4150;
  max-height: 62vh;
  overflow: auto;
  background: #fafbfc;
  border: 1px solid var(--brand-card-border);
  border-radius: 8px;
  padding: 16px;
}
</style>
