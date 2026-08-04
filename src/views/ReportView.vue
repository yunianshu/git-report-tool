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

    <!-- 结果区 -->
    <div v-if="state.report.phase !== 'idle'" class="report-results">
      <!-- 生成过程：扫描 / 收集中 -->
      <div v-if="state.report.phase === 'scanning' || state.report.phase === 'collecting'" class="phase-card">
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

      <template v-if="state.report.phase === 'done'">
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

      <el-card shadow="never" class="card">
        <template #header>
          <div class="card-header">
            <span>提交明细（{{ filteredCommits.length }}）</span>
            <el-button type="success" :disabled="!filteredCommits.length" @click="exportReport">
              <el-icon style="margin-right: 4px"><Download /></el-icon>导出 Markdown
            </el-button>
          </div>
        </template>
        <el-collapse v-model="state.report.openProjects">
          <el-collapse-item v-for="g in filteredGroups" :key="g.repo" :name="g.repo" :title="`${g.project}（${g.commits.length} 条）`">
            <el-table :data="g.commits" size="small">
              <el-table-column prop="date" label="日期" width="100" />
              <el-table-column prop="hash" label="哈希" width="90" />
              <el-table-column prop="authorName" label="作者" width="110" />
              <el-table-column prop="subject" label="内容" min-width="340" show-overflow-tooltip />
            </el-table>
          </el-collapse-item>
        </el-collapse>
        <div v-if="!filteredCommits.length" class="collect-hint">该时间范围内无提交记录</div>
      </el-card>
      </template>
    </div>

    <!-- 空状态引导 -->
    <div v-else class="report-empty">
      <div class="table-empty">
        <el-icon><MagicStick /></el-icon>
        <p>选择周期后点击「生成报告」，自动扫描仓库并汇总提交</p>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { ElMessage } from 'element-plus'
import { state } from '../store'
import { todayStr, addDays, untilToEnd } from '../utils/date'
import { groupByProject, buildMarkdown } from '../utils/report'
import { toPlain } from '../utils/ipc'
import { shortPath } from '../utils/path'
import BaseChart from '../components/BaseChart.vue'
import CountUp from '../components/CountUp.vue'

const period = ref('daily')
// 日报默认取「昨天」——最后一个完整工作日（当天通常尚无提交）
const dailyDate = ref(addDays(todayStr(), -1))
const customSince = ref(addDays(todayStr(), -6))
const customUntil = ref(todayStr())
const onlyMine = ref(true)
const authorFilter = ref([])

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

async function exportReport() {
  const titleMap = {
    daily: `项目日报 — ${dailyDate.value}`,
    weekly: `项目周报 — ${rangeLabel.value}`,
    monthly: `项目月报 — ${rangeLabel.value}`,
    custom: `项目报告 — ${rangeLabel.value}`,
  }
  const md = buildMarkdown({
    title: titleMap[period.value],
    subtitle: `数据来源：${state.discoveredRepos.length} 个 Git 仓库 · 作者：${onlyMine.value ? `本人(${(state.config.identities || []).length}个账号)` : '全部作者'}`,
    commits: filteredCommits.value,
    stats: {
      commitCount: filteredCommits.value.length,
      projectCount: filteredGroups.value.length,
      authorCount: authorCount.value,
    },
  })
  const safeName = titleMap[period.value].replace(/[\\/:*?"<>|]/g, '_')
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
</style>
