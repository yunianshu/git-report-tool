<template>
  <el-card shadow="never" class="card">
    <template #header>
      <div class="card-header">
        <span>发布</span>
        <span class="ver-info">
          目标 <b>{{ activeTarget ? (activeTarget.name || '未命名') : '—' }}</b>
          <el-divider direction="vertical" />
          本地版本 <b>{{ publishVersion || '—' }}</b>
          <el-divider direction="vertical" />
          线上版本 <b>{{ state.deploy.currentVersion || '未知' }}</b>
          <el-button text size="small" type="primary" :disabled="!form.id || dirty" @click="queryReleases">查询</el-button>
        </span>
      </div>
    </template>
    <div class="publish-row">
      <el-button
        type="primary"
        size="large"
        class="publish-btn"
        :loading="state.deploy.running"
        :disabled="!canPublish"
        @click="publish"
      >
        🚀 发布 {{ publishVersion || '' }}
      </el-button>
      <el-button v-if="state.deploy.running" size="large" type="warning" plain @click="cancelRun">取消发布</el-button>
      <el-select
        v-if="releases.length"
        v-model="rollbackVersion"
        placeholder="历史版本"
        size="large"
        style="width: 150px; margin-left: 8px"
      >
        <el-option v-for="r in releases" :key="r" :value="r" :label="r" />
      </el-select>
      <el-button
        v-if="releases.length && rollbackVersion"
        size="large"
        :loading="rollingBack"
        @click="doRollback(rollbackVersion)"
      >回滚到此版本</el-button>
    </div>
    <div v-if="!canPublish && !state.deploy.running" class="f-hint">
      发布前需：项目已保存、本地目录与 Compose 文件存在、已识别版本号、当前目标已配置服务器与部署目录
    </div>
    <div class="stages">
      <div
        v-for="(s, i) in STAGE_LIST"
        :key="s.id"
        class="stage-chip"
        :class="stageClass(s.id)"
      >
        <span class="stage-idx">{{ i + 1 }}</span>
        <span>{{ s.label }}</span>
        <span class="stage-mark">{{ stageMark(s.id) }}</span>
      </div>
    </div>
  </el-card>

  <el-card shadow="never" class="card">
    <template #header>
      <div class="card-header">
        <span>发布日志</span>
        <el-button text size="small" @click="clearLogs">清屏</el-button>
      </div>
    </template>
    <div ref="logBox" class="log-box">
      <div v-if="!state.deploy.logs.length" class="log-empty">暂无日志，点击「发布」后此处实时显示服务器输出</div>
      <div v-for="(l, i) in state.deploy.logs" :key="i" class="log-line" :class="'log-' + l.level">
        <span class="log-ts">{{ l.ts }}</span>{{ l.text }}
      </div>
    </div>
  </el-card>
</template>

<script setup>
import { ref, computed, watch, nextTick } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { state } from '../../store'

const props = defineProps({
  /** 部署表单（响应式对象，只读使用） */
  form: { type: Object, required: true },
  /** 当前部署目标 */
  activeTarget: { type: Object, default: null },
  /** 当前部署目标 id */
  activeTargetId: { type: String, default: '' },
  /** 本次发布会使用的版本号 */
  publishVersion: { type: String, default: '' },
  /** 表单是否有未保存修改 */
  dirty: { type: Boolean, default: false },
})
const emit = defineEmits(['history-changed'])

/** 与主进程 deploy-service.STAGES 保持一致 */
const STAGE_LIST = [
  { id: 'check', label: '检查项目' },
  { id: 'package', label: '项目打包' },
  { id: 'upload', label: '上传文件' },
  { id: 'backup', label: '备份服务器' },
  { id: 'extract', label: '解压新版本' },
  { id: 'build', label: 'Docker构建' },
  { id: 'start', label: '启动服务' },
  { id: 'health', label: '健康检查' },
]

const rollingBack = ref(false)
const releases = ref([])
const rollbackVersion = ref('')
const logBox = ref(null)

const canPublish = computed(() => {
  if (state.deploy.running || !props.form.id || props.dirty || !props.activeTarget) return false
  const t = props.activeTarget
  return !!(props.form.name && props.form.localPath && props.publishVersion && t.server.host && t.remotePath)
})

// ─── 发布（当前目标） ───
function resetStages() {
  const st = {}
  for (const s of STAGE_LIST) st[s.id] = { status: 'waiting', durationMs: 0 }
  state.deploy.stages = st
  state.deploy.logs = []
  state.deploy.packageCount = 0
  state.deploy.uploadPercent = 0
}

async function publish() {
  const v = props.publishVersion
  const t = props.activeTarget
  const oldV = state.deploy.currentVersion || '（未知）'
  try {
    await ElMessageBox.confirm(
      `即将发布 ${props.form.name} ${v} 到【${t.name}】${t.server.host}:${t.remotePath}（当前线上版本 ${oldV}）。发布过程中会备份并自动构建重启，是否继续？`,
      '确认发布',
      { type: 'warning', confirmButtonText: '🚀 发布', cancelButtonText: '取消' },
    )
  } catch { return }
  resetStages()
  state.deploy.running = true
  try {
    const r = await window.gitReport.deployRun(props.form.id, props.activeTargetId)
    if (r && r.error) ElMessage.error(r.error)
  } catch (e) {
    state.deploy.running = false
    ElMessage.error(e.message || String(e))
  }
  if (!state.deploy.running) emit('history-changed') // done 事件已关闭 running
}

async function cancelRun() {
  try {
    await ElMessageBox.confirm('确认取消本次发布？服务器脚本将按自动回滚策略处理。', '取消发布', { type: 'warning' })
  } catch { return }
  await window.gitReport.deployCancel()
}

// ─── 阶段样式 ───
function stageClass(id) {
  const st = state.deploy.stages[id]
  return st ? `is-${st.status}` : 'is-waiting'
}
function stageMark(id) {
  const st = state.deploy.stages[id]
  if (!st) return ''
  return {
    waiting: '·', running: '…', success: '✓', failed: '✗', skipped: '—', rollback: '↩',
  }[st.status] || ''
}

// ─── 日志 ───
function clearLogs() { state.deploy.logs = [] }
watch(() => state.deploy.logs.length, async () => {
  await nextTick()
  if (logBox.value) logBox.value.scrollTop = logBox.value.scrollHeight
})

// ─── 版本列表 / 回滚（当前目标） ───
async function queryReleases() {
  try {
    const r = await window.gitReport.deployReleases(props.form.id, props.activeTargetId)
    if (r && r.ok) {
      releases.value = r.releases || []
      state.deploy.currentVersion = r.current || state.deploy.currentVersion
      if (!releases.value.length) ElMessage.info('服务器暂无历史版本')
    } else {
      ElMessage.error((r && r.error) || '查询失败')
    }
  } catch (e) {
    ElMessage.error(e.message || String(e))
  }
}

async function doRollback(version, targetId) {
  const tid = targetId || props.activeTargetId
  const tName = (props.form.targets.find((x) => x.id === tid) || {}).name || ''
  try {
    await ElMessageBox.confirm(
      `确认回滚到 ${version}${tName ? `（目标：${tName}）` : ''}？服务器将停止当前版本、切换 current 并重启目标版本，随后执行健康检查。`,
      '确认回滚',
      { type: 'warning', confirmButtonText: '回滚' },
    )
  } catch { return }
  rollingBack.value = true
  resetStages()
  state.deploy.running = true
  try {
    const r = await window.gitReport.deployRollback(props.form.id, tid, version)
    if (r && r.ok) {
      ElMessage.success(`已回滚到 ${version}`)
      if (tid === props.activeTargetId) state.deploy.currentVersion = version
    } else if (r && r.error) {
      ElMessage.error(r.error)
    }
  } finally {
    rollingBack.value = false
    state.deploy.running = false
    emit('history-changed')
  }
}

/** 切换项目时清空版本列表与回滚选择（由组合层调用） */
function resetSelection() {
  releases.value = []
  rollbackVersion.value = ''
}

defineExpose({ doRollback, resetSelection })
</script>

<style scoped>
.ver-info { font-size: 13px; color: var(--brand-text-sub); font-weight: 400; }
.ver-info b { color: var(--brand-text); font-family: var(--brand-mono); }

.publish-row { display: flex; align-items: center; margin-bottom: 14px; flex-wrap: wrap; }
.publish-btn { min-width: 220px; font-size: 15px; font-weight: 600; }

.stages { display: flex; flex-wrap: wrap; gap: 8px; }
.stage-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  border-radius: 7px;
  border: 1px solid #e2e6ed;
  font-size: 12.5px;
  color: #8a909c;
  background: #fafbfc;
  transition: all .2s ease;
}
.stage-idx {
  width: 16px; height: 16px; line-height: 16px; text-align: center;
  border-radius: 50%;
  background: #e2e6ed; color: #fff;
  font-size: 11px;
  font-family: var(--brand-mono);
}
.stage-mark { font-family: var(--brand-mono); font-weight: 600; }
.stage-chip.is-running { border-color: var(--brand-accent); color: var(--brand-accent); background: var(--el-color-primary-light-9); }
.stage-chip.is-running .stage-idx { background: var(--brand-accent); }
.stage-chip.is-success { border-color: #b7e1b7; color: #3f9d3f; background: #f2faf2; }
.stage-chip.is-success .stage-idx { background: #67c23a; }
.stage-chip.is-failed { border-color: #efb8b8; color: #d54949; background: #fdf3f3; }
.stage-chip.is-failed .stage-idx { background: #f56c6c; }
.stage-chip.is-rollback { border-color: #f0d3a8; color: #c8842c; background: #fdf8ef; }
.stage-chip.is-rollback .stage-idx { background: #e6a23c; }
.stage-chip.is-skipped { opacity: .65; }

.log-box {
  height: 300px;
  overflow: auto;
  background: #14181f;
  border-radius: 8px;
  padding: 12px 14px;
  font-family: var(--brand-mono);
  font-size: 12.5px;
  line-height: 1.65;
}
.log-empty { color: #5b6470; text-align: center; padding-top: 120px; }
.log-line { white-space: pre-wrap; word-break: break-all; color: #b8c0ca; }
.log-ts { color: #5b6470; margin-right: 10px; }
.log-success { color: #7fd07f; }
.log-warn { color: #e8b45e; }
.log-error { color: #f08a8a; }
</style>
