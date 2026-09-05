<template>
  <el-card shadow="never" class="card">
    <template #header>
      <div class="card-header">
        <span>发布历史</span>
        <el-button text size="small" type="danger" :disabled="!history.length" @click="clearHistory">清空</el-button>
      </div>
    </template>
    <el-table :data="history" size="small" max-height="320" empty-text="暂无发布记录">
      <el-table-column prop="version" label="版本" width="100">
        <template #default="{ row }">
          <span class="mono">{{ row.version || '—' }}</span>
          <el-tag v-if="row.version && row.version === state.deploy.currentVersion" size="small" type="success" effect="plain" class="cur-tag">运行中</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="目标" width="90">
        <template #default="{ row }">
          <span>{{ row.targetName || '默认' }}</span>
        </template>
      </el-table-column>
      <el-table-column label="时间" width="150">
        <template #default="{ row }">{{ fmtTime(row.startedAt) }}</template>
      </el-table-column>
      <el-table-column label="类型" width="70">
        <template #default="{ row }">
          <el-tag size="small" :type="{ rollback: 'warning', 'db-restore': 'danger' }[row.type] || 'primary'" effect="plain">
            {{ { deploy: '发布', rollback: '回滚', 'db-restore': '数据恢复' }[row.type] || row.type }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="90">
        <template #default="{ row }">
          <el-tag size="small" :type="statusType(row.status)">{{ statusText(row.status) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="耗时" width="75">
        <template #default="{ row }">{{ fmtDur(row.durationMs) }}</template>
      </el-table-column>
      <el-table-column prop="message" label="说明" show-overflow-tooltip />
      <el-table-column label="操作" width="130" fixed="right">
        <template #default="{ row }">
          <el-button text size="small" type="primary" @click="viewLog(row)">日志</el-button>
          <el-button
            v-if="row.type === 'deploy' && row.status === 'success' && row.version !== state.deploy.currentVersion"
            text size="small" type="warning" @click="emit('rollback', row.version, row.targetId)"
          >回滚</el-button>
        </template>
      </el-table-column>
    </el-table>
  </el-card>

  <!-- 历史日志查看 -->
  <el-dialog v-model="logDialog" title="部署日志" width="860px" top="6vh">
    <pre class="dialog-log">{{ dialogLog || '（无日志内容）' }}</pre>
  </el-dialog>
</template>

<script setup>
import { ref } from 'vue'
import { ElMessageBox } from 'element-plus'
import { state } from '../../store'
import { fmtTime, fmtDur } from './deploy-form'

const props = defineProps({
  /** 当前项目 id（空串表示未保存的新项目，查询全部历史） */
  projectId: { type: String, default: '' },
})
const emit = defineEmits(['rollback'])

const history = ref([])
const logDialog = ref(false)
const dialogLog = ref('')

// ─── 历史 ───
async function loadHistory() {
  try {
    history.value = await window.gitReport.deployHistoryList(props.projectId || undefined) || []
  } catch { history.value = [] }
}

async function viewLog(row) {
  dialogLog.value = await window.gitReport.deployHistoryReadLog(row.logFile) || ''
  logDialog.value = true
}

async function clearHistory() {
  try {
    await ElMessageBox.confirm('确认清空该项目的发布历史？（服务器文件不受影响）', '清空历史', { type: 'warning' })
  } catch { return }
  await window.gitReport.deployHistoryClear(props.projectId || undefined)
  loadHistory()
}

// ─── 工具 ───
function statusType(s) {
  return { success: 'success', failed: 'danger', rolled_back: 'warning', canceled: 'info', running: 'primary' }[s] || 'info'
}
function statusText(s) {
  return { success: '成功', failed: '失败', rolled_back: '已回滚', canceled: '已取消', running: '进行中' }[s] || s
}

defineExpose({ reload: loadHistory })
</script>

<style scoped>
.cur-tag { margin-left: 6px; }
.dialog-log {
  background: #14181f;
  color: #b8c0ca;
  border-radius: 8px;
  padding: 14px;
  max-height: 62vh;
  overflow: auto;
  font-family: var(--brand-mono);
  font-size: 12.5px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
  margin: 0;
}
</style>
