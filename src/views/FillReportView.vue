<template>
  <div class="fill-page">
    <PageHeader
      eyebrow="FILL REPORT"
      title="一键填报"
      description="按 Git 提交时间自动计算工时（扣午休、0.5h 向下取整），确认后一键写入禅道任务。"
    />

    <!-- 顶部工具条：选日期 → 选项目 → 生成报告 -->
    <el-card shadow="never" class="card">
      <div class="fill-toolbar">
        <el-date-picker
          v-model="fillDate"
          type="date"
          value-format="YYYY-MM-DD"
          :clearable="false"
          :disabled-date="(d) => d.getTime() > Date.now()"
          :shortcuts="dateShortcuts"
          style="width: 150px"
        />
        <el-select
          v-model="selectedProjectIds"
          multiple
          filterable
          collapse-tags
          collapse-tags-tooltip
          :max-collapse-tags="3"
          placeholder="选择要填报的项目"
          class="project-select"
        >
          <el-option
            v-for="p in fillableProjects"
            :key="p.id"
            :value="p.id"
            :label="p.name"
            :disabled="p.repoCount === 0"
          >
            <div class="project-option">
              <span class="project-option-name">{{ p.name }}</span>
              <el-tag v-if="bindings[p.id]" size="small" type="success" class="project-option-tag">
                已绑定 #{{ bindings[p.id].taskId }}
              </el-tag>
              <el-tag v-else-if="p.repoCount === 0" size="small" type="info" class="project-option-tag">无仓库</el-tag>
              <el-tag v-else size="small" type="warning" class="project-option-tag">未绑定</el-tag>
            </div>
          </el-option>
        </el-select>
        <el-button
          type="primary"
          size="large"
          :loading="state.fillReport.running"
          :disabled="!canGenerate"
          @click="generate"
        >
          <el-icon style="margin-right: 4px"><MagicStick /></el-icon>生成报告
        </el-button>
      </div>

      <el-alert
        v-if="!zentaoConfigured"
        type="warning"
        :closable="false"
        class="warn"
        title="禅道未配置：绑定项目与提交工时需要禅道地址与账号。"
      >
        <el-button size="small" type="primary" plain @click="emit('navigate', 'fill-settings')">去设置</el-button>
      </el-alert>
      <el-alert
        v-else-if="!hanprintConfigured"
        type="info"
        :closable="false"
        class="warn"
        title="汉印平台未配置：将只填报禅道工时（可到「设置 → 一键填报」配置汉印账号）。"
      />
      <el-alert
        v-else-if="plan && plan.ztError"
        type="error"
        :closable="false"
        class="warn"
        :title="`禅道任务获取失败：${plan.ztError}`"
      />
      <el-alert
        v-else-if="hanprintConfigured && plan && plan.hpError"
        type="error"
        :closable="false"
        class="warn"
        :title="`汉印任务获取失败：${plan.hpError}`"
      />
      <el-alert
        v-if="identitiesMissing"
        type="info"
        :closable="false"
        class="warn"
        title="尚未配置本人身份，无法过滤你的提交；请到「设置 → 个人身份」添加。"
      />
      <div v-if="selectedProjectIds.some((id) => !bindings[id])" class="bind-tip">
        部分所选项目尚未绑定禅道任务：生成报告后可在明细中绑定，绑定一次长期生效。
      </div>
    </el-card>

    <!-- 生成中 -->
    <div v-if="state.fillReport.running" class="fill-phase">
      <el-icon class="is-loading"><Loading /></el-icon>
      <span>正在获取提交并计算工时…</span>
    </div>

    <template v-if="plan">
      <!-- 提交明细（工时计划） -->
      <el-card shadow="never" class="card">
        <template #header>
          <div class="card-header">
            <span>提交明细 · {{ plan.date }}（首条提交开始计时，午休 {{ plan.workConfig.lunchStart }}–{{ plan.workConfig.lunchEnd }}，{{ plan.workConfig.workEnd }} 下班）</span>
            <span class="header-meta">{{ plan.planned.length }} 个项目 · {{ plan.commitCount }} 条提交 · 合计 {{ totalHours }}h</span>
          </div>
        </template>
        <div v-if="plan.planned.length" class="plan-list">
          <div v-for="(p, i) in plan.planned" :key="i" class="prow" :class="{ unbound: !p.taskId }">
            <div class="pline">
              <span class="ptime">{{ p.firstTime }}–{{ p.lastTime }}</span>
              <span class="phours">{{ p.hours }}h</span>
              <span class="pmsg">
                <pre class="pwork">{{ p.work }}</pre>
                <span class="pproj">{{ p.projectName }} · {{ p.commitCount }} 条提交</span>
              </span>
            </div>
            <div class="pmatch">
              <el-tag v-if="p.taskId" size="small" type="success">禅道 #{{ p.taskId }} {{ p.taskName || '已绑定任务' }}</el-tag>
              <template v-else>
                <el-tag size="small" type="danger">未绑定</el-tag>
                <el-button size="small" type="primary" plain :disabled="!zentaoConfigured" @click="openBind(p.projectId)">绑定禅道任务</el-button>
              </template>
            </div>
          </div>
        </div>
        <div v-else class="collect-hint">
          {{ plan.identitiesMissing ? '请先配置本人身份' : `${plan.date} 所选项目没有你的提交记录（可改选日期或项目）` }}
        </div>
      </el-card>

      <!-- 按任务汇总 + 提交操作 -->
      <el-card v-if="plan.planned.length" shadow="never" class="card">
        <template #header>
          <div class="card-header">
            <span>按禅道任务汇总</span>
            <el-tag v-if="plan.submittedAt" type="success" size="small">已于 {{ plan.submittedAt }} 提交</el-tag>
          </div>
        </template>
        <div v-if="plan.tasks.length" class="sum-list">
          <div v-for="t in plan.tasks" :key="t.taskId" class="sumline">
            <span class="sum-name">
              #{{ t.taskId }} {{ t.taskName || '（任务已不在「我的任务」列表）' }}
            </span>
            <span class="sum-right">
              <template v-if="t.taskLeft !== null">剩余 {{ t.taskLeft }}h → {{ t.left }}h · </template>{{ t.consumed }}h
            </span>
          </div>
          <div class="sumline sum-total">
            <span>合计</span>
            <span>{{ totalHours }}h</span>
          </div>
        </div>
        <div v-else class="collect-hint">暂无可填报的任务：请先为有提交的项目绑定禅道任务</div>
        <!-- 汉印条目预览（按工时占比，合计 100%） -->
        <div v-if="plan.hpItems && plan.hpItems.length" class="hp-block">
          <div class="hp-title">汉印工时填报（{{ plan.hpItems.length }} 条 · 占比合计 {{ hpPercentTotal }}%）</div>
          <div v-for="(item, i) in plan.hpItems" :key="i" class="hpline">
            <span class="sum-name">{{ item.ProjectName }} · {{ item.TaskName }}</span>
            <span class="sum-right">{{ item.Percent }}%</span>
          </div>
        </div>
        <div v-else-if="hanprintConfigured && plan.tasks.length && plan.hpUnmatched && plan.hpUnmatched.length" class="submit-hint">
          汉印未匹配到这些禅道任务对应的报工任务，相关工时将只写入禅道：#{{ plan.hpUnmatched.join('、#') }}
        </div>
        <div class="fill-actions">
          <el-button :disabled="!plan.planned.length" @click="copyReport">
            <el-icon style="margin-right: 4px"><CopyDocument /></el-icon>复制报告
          </el-button>
          <el-button :disabled="!canSubmit" @click="submitFill(true)">
            <el-icon style="margin-right: 4px"><View /></el-icon>预览提交
          </el-button>
          <el-button
            type="success"
            size="large"
            :disabled="!canSubmit || !!plan.submittedAt"
            :loading="state.fillReport.submitting"
            @click="submitFill(false)"
          >
            <el-icon style="margin-right: 4px"><Position /></el-icon>{{ plan.submittedAt ? '已提交' : '一键提交' }}
          </el-button>
        </div>
        <div v-if="unmatchedCount" class="submit-hint">有 {{ unmatchedCount }} 条提交所属项目未绑定禅道任务，绑定后才能提交。</div>
      </el-card>
    </template>

    <!-- 空状态引导（未生成时） -->
    <div v-if="!plan && !state.fillReport.running" class="fill-hint">
      <el-alert type="info" :closable="false" show-icon title="选择日期与项目后点击「生成报告」，自动按提交时间计算每个任务的工时" />
    </div>

    <!-- 绑定禅道任务弹窗 -->
    <el-dialog
      v-model="bindDialog.visible"
      :title="`绑定禅道任务 · ${bindDialog.projectName}`"
      width="600"
    >
      <el-select
        v-model="bindDialog.taskId"
        filterable
        :loading="bindDialog.loading"
        placeholder="搜索选择禅道任务（我的任务列表）"
        style="width: 100%"
      >
        <el-option v-for="t in bindDialog.options" :key="t.id" :value="t.id" :label="`#${t.id} ${t.name}`">
          <div class="task-option">
            <span class="task-option-name">#{{ t.id }} {{ t.name }}</span>
            <span class="task-option-meta">{{ t.status || '-' }} · 剩余 {{ t.left }}h</span>
          </div>
        </el-option>
      </el-select>
      <div class="bind-hint">绑定一次后长期生效，之后填报该项目会自动关联此任务。</div>
      <template #footer>
        <el-button v-if="bindDialog.boundTaskId" type="danger" plain @click="doUnbind">解除绑定</el-button>
        <el-button @click="bindDialog.visible = false">取消</el-button>
        <el-button type="primary" :disabled="!bindDialog.taskId" @click="doBind">保存绑定</el-button>
      </template>
    </el-dialog>

    <!-- 提交预览弹窗 -->
    <el-dialog v-model="previewDialog.visible" title="提交预览（未写入禅道）" width="720" top="6vh">
      <pre class="preview-content">{{ previewDialog.content }}</pre>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { state } from '../store'
import { todayStr } from '../utils/date'
import { toPlain } from '../utils/ipc'
import { reposForProject } from '../utils/project-context'
import { useProjects } from '../composables/useProjects'
import PageHeader from '../components/PageHeader.vue'

const emit = defineEmits(['navigate'])
const { loadProjects } = useProjects()

const selectedProjectIds = ref([])
const bindings = ref({})
const bindDialog = ref({ visible: false, projectId: '', projectName: '', taskId: null, boundTaskId: null, options: [], loading: false })
const previewDialog = ref({ visible: false, content: '' })

const dateShortcuts = [
  { text: '今天', value: new Date() },
  { text: '昨天', value: new Date(Date.now() - 86400000) },
]

/** 跨视图保留：日期与计划存共享状态，切换视图再回来不丢 */
const fillDate = computed({
  get: () => state.fillReport.date || todayStr(),
  set: (v) => { state.fillReport.date = v },
})
const plan = computed(() => state.fillReport.plan)

const zentaoConfigured = computed(() => {
  const zt = state.config.zentao || {}
  return !!(zt.baseUrl && zt.account && zt.pwdConfigured)
})
const hanprintConfigured = computed(() => {
  const hp = state.config.hanprint || {}
  return !!(hp.baseUrl && hp.account && hp.pwdConfigured)
})
const identitiesMissing = computed(() => !(state.config.identities || []).length)

/** 可填报项目：附带其覆盖的仓库数（0 时禁止选择） */
const fillableProjects = computed(() =>
  state.projects.items
    .filter((p) => p.localPath)
    .map((p) => ({ ...p, repoCount: reposForProject(p, state.discoveredRepos).length })),
)

const canGenerate = computed(() => !!(fillDate.value && selectedProjectIds.value.length))
const canSubmit = computed(() => !!(plan.value && plan.value.tasks.length && !plan.value.ztError && !unmatchedCount.value && zentaoConfigured.value))
const unmatchedCount = computed(() => (plan.value ? plan.value.planned.filter((p) => !p.taskId).length : 0))
const totalHours = computed(() =>
  plan.value ? (Math.round(plan.value.planned.reduce((s, p) => s + p.hours, 0) * 100) / 100).toFixed(2) : '0.00',
)
const hpPercentTotal = computed(() =>
  plan.value && Array.isArray(plan.value.hpItems)
    ? plan.value.hpItems.reduce((s, item) => s + (item.Percent || 0), 0)
    : 0,
)

onMounted(async () => {
  loadProjects()
  try {
    bindings.value = await window.gitReport.fillBindings()
  } catch { /* noop */ }
})

async function generate() {
  if (state.fillReport.running) return
  const chosen = fillableProjects.value.filter((p) => selectedProjectIds.value.includes(p.id))
  const invalid = chosen.find((p) => p.repoCount === 0)
  if (invalid) {
    ElMessage.warning(`项目「${invalid.name}」没有可识别的 Git 仓库`)
    return
  }
  state.fillReport.running = true
  try {
    const payload = {
      date: fillDate.value,
      projects: chosen.map((p) => ({
        id: p.id,
        name: p.name,
        repos: reposForProject(p, state.discoveredRepos).map((r) => r.path),
      })),
    }
    const r = await window.gitReport.fillPlan(toPlain(payload))
    if (!r.ok) {
      ElMessage.error(r.error || '生成失败')
      return
    }
    state.fillReport.plan = r
    bindings.value = { ...bindings.value, ...r.bindings }
    if (!r.planned.length && !r.identitiesMissing) {
      ElMessage.warning(`${r.date} 所选项目没有你的提交记录`)
    }
    if (r.ztError && zentaoConfigured.value) {
      ElMessage.warning(`禅道任务获取失败：${r.ztError}`)
    }
  } catch (e) {
    ElMessage.error(`生成失败：${e?.message || e}`)
  } finally {
    state.fillReport.running = false
  }
}

/** 打开绑定弹窗；任务列表优先用计划带回的，缺失时现拉 */
async function openBind(projectId) {
  const project = state.projects.items.find((p) => p.id === projectId)
  const bound = bindings.value[projectId]
  bindDialog.value = {
    visible: true,
    projectId,
    projectName: project?.name || projectId,
    taskId: bound ? bound.taskId : (plan.value?.suggested?.[projectId] || null),
    boundTaskId: bound ? bound.taskId : null,
    options: plan.value?.ztTasks || [],
    loading: false,
  }
  if (!bindDialog.value.options.length) {
    bindDialog.value.loading = true
    try {
      const r = await window.gitReport.fillZtTasks()
      if (r.ok) bindDialog.value.options = r.tasks
      else ElMessage.error(r.error || '禅道任务获取失败')
    } catch (e) {
      ElMessage.error(`禅道任务获取失败：${e?.message || e}`)
    } finally {
      bindDialog.value.loading = false
    }
  }
}

async function doBind() {
  const { projectId, taskId } = bindDialog.value
  if (!projectId || !taskId) return
  const task = bindDialog.value.options.find((t) => t.id === taskId)
  const r = await window.gitReport.fillBind(projectId, taskId, task ? task.name : '')
  if (!r.ok) {
    ElMessage.error(r.error || '绑定失败')
    return
  }
  bindings.value = { ...bindings.value, [projectId]: r.binding }
  bindDialog.value.visible = false
  ElMessage.success(`已绑定 #${taskId} ${task ? task.name : ''}，后续填报自动关联`)
  // 绑定影响任务匹配与汇总，重新生成报告以刷新
  if (plan.value) generate()
}

async function doUnbind() {
  const { projectId } = bindDialog.value
  await window.gitReport.fillUnbind(projectId)
  const next = { ...bindings.value }
  delete next[projectId]
  bindings.value = next
  bindDialog.value.visible = false
  bindDialog.value.taskId = null
  bindDialog.value.boundTaskId = null
  ElMessage.success('已解除绑定')
  if (plan.value) generate()
}

async function submitFill(preview) {
  const p = plan.value
  if (!p) return
  if (unmatchedCount.value) {
    ElMessage.warning(`有 ${unmatchedCount.value} 条提交未绑定禅道任务，请先绑定`)
    return
  }
  const tasks = p.tasks.map((t) => ({ taskId: t.taskId, taskName: t.taskName, rows: t.rows }))
  const hpItems = Array.isArray(p.hpItems) ? p.hpItems : []
  if (!preview) {
    const hpText = hpItems.length ? `，同时向汉印提交 ${hpItems.length} 条占比记录` : ''
    try {
      await ElMessageBox.confirm(
        `将向 ${tasks.length} 个禅道任务写入 ${p.date} 共 ${totalHours.value} 小时工时${hpText}，是否继续？`,
        '确认提交',
        { type: 'warning', confirmButtonText: '提交', cancelButtonText: '取消' },
      )
    } catch {
      return
    }
  }
  state.fillReport.submitting = true
  try {
    const payload = { tasks, dryRun: preview }
    if (hpItems.length) payload.hp = { items: hpItems }
    const r = await window.gitReport.fillSubmit(toPlain(payload))
    if (!r.ok) {
      ElMessage.error(r.error || '提交失败')
      return
    }
    if (preview) {
      const hpPreview = r.hp && r.hp.json ? r.hp.json : hpItems
      previewDialog.value = {
        visible: true,
        content: `【禅道 recordEstimate】\n${JSON.stringify(r.results, null, 2)}\n\n【汉印 workhour/add】\n${JSON.stringify(hpPreview, null, 2)}`,
      }
    } else {
      state.fillReport.plan = { ...p, submittedAt: new Date().toTimeString().slice(0, 5) }
      ElMessage.success(`已写入禅道 ${r.results.length} 个任务的工时${r.hp ? `，汉印 ${hpItems.length} 条占比记录` : ''}`)
    }
  } catch (e) {
    ElMessage.error(`提交失败：${e?.message || e}`)
  } finally {
    state.fillReport.submitting = false
  }
}

function buildReportText() {
  const p = plan.value
  const lines = [`一键填报 · ${p.date}`, `共 ${p.commitCount} 条提交 · ${p.planned.length} 个项目 · 合计 ${totalHours.value}h`, '']
  for (const item of p.planned) {
    lines.push(`${item.firstTime}–${item.lastTime}  ${item.hours}h  [${item.projectName}]`)
    lines.push(item.work)
    lines.push('')
  }
  lines.push('按禅道任务汇总：')
  for (const t of p.tasks) {
    lines.push(`#${t.taskId} ${t.taskName}  ${t.consumed}h${t.taskLeft !== null ? `（剩余 ${t.taskLeft}h → ${t.left}h）` : ''}`)
  }
  return lines.join('\n')
}

async function copyReport() {
  try {
    await window.gitReport.copyText(buildReportText())
    ElMessage.success('已复制到剪贴板')
  } catch (e) {
    ElMessage.error('复制失败')
  }
}
</script>

<style scoped>
.fill-toolbar {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
}
.project-select { width: 420px; }
.project-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.project-option-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.project-option-tag { flex-shrink: 0; }
.bind-tip {
  margin-top: 10px;
  font-size: 12px;
  color: #909399;
}
.warn { margin-top: 12px; }
.fill-phase {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 22px 4px;
  color: #6b7280;
  font-size: 13px;
}
.fill-hint { margin-top: 4px; }
.collect-hint {
  padding: 22px 0;
  text-align: center;
  color: #909399;
  font-size: 13px;
}
.plan-list .prow {
  border-top: 1px solid var(--brand-card-border, #eef0f4);
  padding: 10px 2px;
}
.plan-list .prow:first-child { border-top: none; }
.pline {
  display: flex;
  gap: 12px;
  align-items: baseline;
}
.ptime {
  font-family: var(--brand-mono, monospace);
  font-size: 12.5px;
  font-weight: 700;
  color: #0e7a6d;
  width: 108px;
  flex-shrink: 0;
}
.phours {
  font-family: var(--brand-mono, monospace);
  font-size: 12px;
  color: #4a5160;
  width: 48px;
  flex-shrink: 0;
}
.pmsg { flex: 1; min-width: 0; }
.pwork {
  margin: 0;
  font-family: inherit;
  font-size: 13px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
  color: #2a303c;
}
.pproj {
  display: block;
  font-size: 11.5px;
  color: #9ca1af;
  margin-top: 4px;
}
.pmatch {
  margin-top: 6px;
  display: flex;
  gap: 8px;
  align-items: center;
}
.prow.unbound .pmatch { padding-left: 120px; }
.sum-list .sumline {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 2px;
  font-size: 13px;
  border-top: 1px dashed var(--brand-card-border, #eef0f4);
}
.sum-list .sumline:first-child { border-top: none; }
.sum-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sum-right {
  font-family: var(--brand-mono, monospace);
  color: #4a5160;
  flex-shrink: 0;
}
.sum-total {
  border-top: 1px solid var(--brand-card-border, #eef0f4) !important;
  font-weight: 700;
}
.fill-actions {
  display: flex;
  gap: 10px;
  margin-top: 14px;
  padding-top: 14px;
  border-top: 1px solid var(--brand-card-border, #eef0f4);
}
.hp-block {
  margin-top: 12px;
  padding: 10px 12px;
  background: #fafbfc;
  border: 1px solid var(--brand-card-border, #eef0f4);
  border-radius: 8px;
}
.hp-title {
  font-size: 12.5px;
  font-weight: 600;
  color: #4a5160;
  margin-bottom: 6px;
}
.hpline {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 5px 0;
  font-size: 12.5px;
}
.submit-hint {
  margin-top: 10px;
  font-size: 12px;
  color: #d64545;
}
.bind-hint {
  margin-top: 10px;
  font-size: 12px;
  color: #909399;
}
.task-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.task-option-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.task-option-meta {
  font-size: 11.5px;
  color: #9ca1af;
  flex-shrink: 0;
}
.preview-content {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: var(--brand-mono, monospace);
  font-size: 12px;
  line-height: 1.7;
  color: #3a4150;
  max-height: 62vh;
  overflow: auto;
  background: #fafbfc;
  border: 1px solid var(--brand-card-border, #eef0f4);
  border-radius: 8px;
  padding: 14px;
}
</style>
