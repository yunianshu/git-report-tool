<template>
  <div>
    <!-- 报告参数 -->
    <el-card shadow="never" class="card">
      <template #header>
        <div class="card-header">
          <span>报告参数</span>
          <el-button type="primary" :loading="collecting" :disabled="!state.repos.length" @click="doCollect">
            <el-icon style="margin-right: 4px"><DataAnalysis /></el-icon>收集提交
          </el-button>
        </div>
      </template>

      <el-form label-width="70px">
        <el-form-item label="周期">
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
            style="margin-left: 16px"
          />
          <template v-else-if="period === 'custom'">
            <el-date-picker
              v-model="customSince"
              type="date"
              value-format="YYYY-MM-DD"
              placeholder="开始日期"
              style="margin-left: 16px"
            />
            <span style="margin: 0 8px; color: #909399">至</span>
            <el-date-picker v-model="customUntil" type="date" value-format="YYYY-MM-DD" placeholder="结束日期" />
          </template>
          <el-tag v-else type="info" style="margin-left: 16px">{{ rangeLabel }}</el-tag>
        </el-form-item>

        <el-form-item label="作者">
          <el-switch
            v-model="onlyMine"
            inline-prompt
            active-text="只看本人"
            inactive-text="全部作者"
            :active-value="true"
            :inactive-value="false"
          />
          <span v-if="state.config?.myIdentity?.name" class="progress-text" style="margin-left: 12px">
            本人：{{ state.config.myIdentity.name }} &lt;{{ state.config.myIdentity.email }}&gt;
          </span>
          <el-checkbox-group
            v-if="!onlyMine && authors.length"
            v-model="authorFilter"
            style="margin-left: 16px"
          >
            <el-checkbox v-for="a in authors" :key="a.name" :value="a.name">
              {{ a.name }}（{{ a.count }}）
            </el-checkbox>
          </el-checkbox-group>
        </el-form-item>
      </el-form>

      <el-alert
        v-if="!state.repos.length"
        type="warning"
        :closable="false"
        title="尚未选择项目，请先在「仓库扫描」页勾选项目。"
        class="warn"
      />
    </el-card>

    <!-- 结果区 -->
    <template v-if="collecting || rawCommits.length">
      <el-row :gutter="12" class="stats">
        <el-col :span="6">
          <el-card shadow="never"><el-statistic title="提交数" :value="filteredCommits.length" /></el-card>
        </el-col>
        <el-col :span="6">
          <el-card shadow="never"><el-statistic title="活跃项目" :value="filteredGroups.length" /></el-card>
        </el-col>
        <el-col :span="6">
          <el-card shadow="never"><el-statistic title="作者数" :value="authorCount" /></el-card>
        </el-col>
        <el-col :span="6">
          <el-card shadow="never"><el-statistic title="时间范围" :value="rangeLabel" /></el-card>
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
        <div v-if="collecting" v-loading="collecting" class="collect-hint">{{ collectText }}</div>
        <el-collapse v-else v-model="openProjects">
          <el-collapse-item v-for="g in filteredGroups" :key="g.repo" :name="g.repo" :title="`${g.project}（${g.commits.length} 条）`">
            <el-table :data="g.commits" size="small">
              <el-table-column prop="date" label="日期" width="100" />
              <el-table-column prop="hash" label="哈希" width="90" />
              <el-table-column prop="authorName" label="作者" width="110" />
              <el-table-column prop="subject" label="内容" min-width="340" show-overflow-tooltip />
            </el-table>
          </el-collapse-item>
        </el-collapse>
      </el-card>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, onBeforeUnmount } from 'vue'
import { ElMessage } from 'element-plus'
import { state } from '../store'
import { todayStr, addDays, untilToEnd } from '../utils/date'
import { groupByProject, buildMarkdown } from '../utils/report'
import BaseChart from '../components/BaseChart.vue'

const period = ref('weekly')
const dailyDate = ref(todayStr())
const customSince = ref(addDays(todayStr(), -6))
const customUntil = ref(todayStr())
const onlyMine = ref(true)
const authorFilter = ref([])

const collecting = ref(false)
const rawCommits = ref([])
const openProjects = ref([])
const collectText = ref('')
let unsubCollect = null
onBeforeUnmount(() => unsubCollect && unsubCollect())

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

async function doCollect() {
  collecting.value = true
  collectText.value = '正在收集提交…'
  const r = range()
  unsubCollect = window.gitReport.onCollectProgress((p) => {
    collectText.value = `正在收集提交… ${p.done}/${p.total}`
  })
  try {
    const data = await window.gitReport.collectCommits(state.repos, {
      since: r.since,
      until: r.until,
      authors: [],
      includeMerges: false,
    })
    rawCommits.value = data
    openProjects.value = []
    if (!data.length) ElMessage.warning('所选时间范围内无提交记录')
  } catch (e) {
    console.error('收集失败', e)
    ElMessage.error('收集提交失败')
  } finally {
    collecting.value = false
    if (unsubCollect) { unsubCollect(); unsubCollect = null }
  }
}

const authors = computed(() => {
  const m = new Map()
  rawCommits.value.forEach((c) => {
    if (!m.has(c.authorName)) m.set(c.authorName, { name: c.authorName, email: c.authorEmail, count: 0 })
    m.get(c.authorName).count += 1
  })
  return [...m.values()].sort((a, b) => b.count - a.count)
})

function isMine(c) {
  const id = state.config?.myIdentity
  if (!id || (!id.name && !id.email)) return false
  return (id.name && c.authorName === id.name) || (id.email && c.authorEmail === id.email)
}

const filteredCommits = computed(() =>
  rawCommits.value.filter((c) => {
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
    grid: { left: 30, right: 20, top: 10, bottom: 30 },
    xAxis: { type: 'value', minInterval: 1 },
    yAxis: { type: 'category', data: top.map((g) => g.project) },
    series: [{
      type: 'bar',
      data: top.map((g) => g.commits.length),
      itemStyle: { color: '#409eff', borderRadius: [0, 4, 4, 0] },
      barMaxWidth: 22,
    }],
  }
})

const trendOption = computed(() => {
  const m = new Map()
  filteredCommits.value.forEach((c) => m.set(c.date, (m.get(c.date) || 0) + 1))
  const sorted = [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
  return {
    tooltip: { trigger: 'axis' },
    grid: { left: 30, right: 20, top: 10, bottom: 30 },
    xAxis: { type: 'category', data: sorted.map((e) => e[0].slice(5)) },
    yAxis: { type: 'value', minInterval: 1 },
    series: [{
      type: 'line',
      smooth: true,
      areaStyle: { opacity: 0.12 },
      data: sorted.map((e) => e[1]),
      itemStyle: { color: '#409eff' },
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
    subtitle: `数据来源：${state.repos.length} 个 Git 仓库 · 作者：${onlyMine.value ? (state.config?.myIdentity?.name || '本人') : '全部作者'}`,
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
  } else if (res && !res.saved) {
    // 用户取消，不提示
  }
}
</script>

<style scoped>
.collect-hint {
  min-height: 120px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #909399;
}
</style>
