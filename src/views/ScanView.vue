<template>
  <div class="scan-page">
    <!-- 扫描配置 -->
    <el-card shadow="never" class="card scan-config-card">
      <template #header>
        <div class="card-header">
          <span>扫描配置</span>
          <el-button type="primary" :loading="scanning" @click="doScan">
            <el-icon style="margin-right: 4px"><Search /></el-icon>开始扫描
          </el-button>
        </div>
      </template>

      <el-form label-width="86px">
        <el-form-item label="扫描根目录">
          <div class="root-manager">
            <!-- 操作行：输入 + 浏览 + 添加 -->
            <div class="root-ops">
              <el-input
                v-model="newRoot"
                placeholder="输入目录路径，如 D:\AiProject，回车添加"
                clearable
                @keyup.enter="addRoot"
              />
              <el-button @click="browseRoot">
                <el-icon><Folder /></el-icon>浏览
              </el-button>
              <el-button type="primary" plain @click="addRoot">添加</el-button>
            </div>
            <!-- 已添加列表 -->
            <div v-if="config.roots.length" class="root-list">
              <div class="root-list-title">已添加 {{ config.roots.length }} 个根目录</div>
              <el-tag
                v-for="(r, i) in config.roots"
                :key="r"
                closable
                type="info"
                class="root-tag"
                @close="removeRoot(i)"
              >
                <el-icon><FolderOpened /></el-icon>
                <span :title="r">{{ r }}</span>
              </el-tag>
            </div>
            <div v-else class="root-empty">尚未添加根目录，请输入路径或点击「浏览」选择文件夹</div>
          </div>
        </el-form-item>

        <el-form-item label="排除目录">
          <div class="exclude-manager">
            <div v-for="group in EXCLUDE_GROUPS" :key="group.label" class="exclude-group">
              <div class="exclude-group-label">{{ group.label }}</div>
              <div class="exclude-group-items">
                <el-checkbox
                  v-for="x in group.items"
                  :key="x"
                  v-model="config.excludes"
                  :value="x"
                  border
                  class="exclude-check"
                >{{ x }}</el-checkbox>
              </div>
            </div>
            <div class="exclude-hint">勾选的目录在扫描时会自动跳过，减少扫描时间</div>
          </div>
        </el-form-item>
      </el-form>
    </el-card>

    <!-- 仓库列表 -->
    <el-card shadow="never" class="card scan-repo-card">
      <template #header>
        <div class="card-header">
          <span>发现的 Git 仓库（{{ state.discoveredRepos.length }}）</span>
          <div class="header-actions">
            <span v-if="scanning" class="progress-text">{{ progressText }}</span>
            <el-button size="small" :disabled="!state.discoveredRepos.length" @click="tableRef?.clearSelection()">清空</el-button>
            <el-button size="small" :disabled="!state.discoveredRepos.length" @click="selectAll">全选</el-button>
            <el-button type="primary" :disabled="!selectedRows.length" @click="useSelected">
              <el-icon style="margin-right: 4px"><Check /></el-icon>使用勾选的 {{ selectedRows.length }} 个项目
            </el-button>
          </div>
        </div>
      </template>

      <div class="table-wrap">
        <el-table
          ref="tableRef"
          :data="state.discoveredRepos"
          height="100%"
          size="small"
          @selection-change="onSelectionChange"
        >
        <template #empty>
          <div class="table-empty">
            <el-icon><FolderOpened /></el-icon>
            <p>暂无仓库，添加根目录后点击「开始扫描」</p>
          </div>
        </template>
        <el-table-column type="selection" width="44" />
        <el-table-column label="项目" min-width="200" show-overflow-tooltip>
          <template #default="{ row }">{{ row.shortName }}</template>
        </el-table-column>
        <el-table-column label="路径" min-width="260" show-overflow-tooltip>
          <template #default="{ row }">{{ row.path }}</template>
        </el-table-column>
        <el-table-column label="远程仓库" min-width="170" show-overflow-tooltip>
          <template #default="{ row }">{{ row.info?.remote || '-' }}</template>
        </el-table-column>
        <el-table-column label="分支" width="90">
          <template #default="{ row }">{{ row.info?.branch || '-' }}</template>
        </el-table-column>
        <el-table-column label="最近提交" min-width="190" show-overflow-tooltip>
          <template #default="{ row }">{{ row.info?.lastCommit || '-' }}</template>
        </el-table-column>
        </el-table>
      </div>

      <div v-if="!state.discoveredRepos.length && !scanning" class="footer-hint">
        <el-alert
          type="info"
          :closable="false"
          title="添加根目录后点击「开始扫描」发现 Git 仓库，勾选需要的项目即可用于报告生成。"
        />
      </div>
    </el-card>
  </div>
</template>

<script setup>
import { ref, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { ElMessage } from 'element-plus'
import { state } from '../store'
import { toPlain } from '../utils/ipc'

const EXCLUDE_GROUPS = [
  { label: '依赖与构建缓存', items: ['node_modules', '.cache', 'fvm_cache', '.gradle', 'Pods'] },
  { label: 'SDK / 运行时', items: ['FlutterSDK', 'android-sdk', 'androidsdk', 'jdk'] },
  { label: 'IDE / 系统', items: ['.idea', '__MACOSX', 'Program Files'] },
]
const EXCLUDE_PRESETS = EXCLUDE_GROUPS.flatMap((g) => g.items)

const config = ref({ roots: [], excludes: [...EXCLUDE_PRESETS], identities: [] })
const newRoot = ref('')
const selectedRows = ref([])
const scanning = ref(false)
const progressText = ref('')
const tableRef = ref(null)

// 流式扫描事件订阅
let unsubProgress = null
let unsubRepoFound = null
let unsubScanDone = null

// 仓库信息并发加载池
const INFO_CONCURRENCY = 6
let infoQueue = []
let infoWorkers = []

// 表格自动滚动跟随（数据多时自动向下滚动展示新发现的仓库）
let followBottom = true
let scrollAttached = false

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function shortPath(p) {
  const parts = p.split(/[\\/]/).filter(Boolean)
  return parts.slice(-2).join('/')
}

onMounted(async () => {
  try {
    config.value = { ...config.value, ...(await window.gitReport.configLoad()) }
  } catch (e) {
    console.error('加载配置失败', e)
  }
  unsubProgress = window.gitReport.onScanProgress((p) => {
    progressText.value = `扫描中… 已处理 ${p.scanned} 个目录（${shortPath(p.current)}）`
  })
  // 每发现一个仓库立即追加到表格（存于共享状态，切换视图不丢失）
  unsubRepoFound = window.gitReport.onScanRepoFound((repoPath) => {
    if (!scanning.value) return
    const row = { path: repoPath, shortName: shortPath(repoPath), info: null }
    state.discoveredRepos.push(row)
    infoQueue.push(row)
    scrollToBottom()
  })
  // 扫描完成
  unsubScanDone = window.gitReport.onScanDone(() => {
    scanning.value = false
    progressText.value = ''
    restoreSelection()
  })

  // 切换视图返回时（不重新扫描）恢复勾选
  nextTick(() => setTimeout(restoreSelection, 300))
})

/** 按 state.selectedRepoPaths 恢复表格勾选 */
let restoring = false
async function restoreSelection() {
  if (!tableRef.value || !state.selectedRepoPaths.length) return
  restoring = true
  const paths = [...state.selectedRepoPaths] // 先拷贝，避免被 selection-change 覆盖
  for (const row of state.discoveredRepos) {
    if (paths.includes(row.path)) {
      tableRef.value.toggleRowSelection(row, true)
      await new Promise((r) => setTimeout(r, 30))
    }
  }
  restoring = false
}
onBeforeUnmount(() => {
  if (unsubProgress) unsubProgress()
  if (unsubRepoFound) unsubRepoFound()
  if (unsubScanDone) unsubScanDone()
})

/** 启动信息加载 worker（保持常驻直到扫描结束且队列清空） */
function ensureInfoWorkers() {
  while (infoWorkers.length < INFO_CONCURRENCY) {
    const worker = (async () => {
      for (;;) {
        const row = infoQueue.shift()
        if (!row) {
          if (!scanning.value) return // 扫描结束且无待处理项 → 退出
          await sleep(80)
          continue
        }
        try {
          row.info = await window.gitReport.repoInfo(row.path)
        } catch {
          row.info = { remote: '-', branch: '-', lastCommit: '-' }
        }
      }
    })()
    infoWorkers.push(worker)
  }
}

/** 表格自动滚动：仅当用户停留在底部时跟随 */
function attachScrollListener() {
  if (scrollAttached) return
  scrollAttached = true
  nextTick(() => {
    const el = document.querySelector('.el-table__body-wrapper')
    if (!el) return
    el.addEventListener('scroll', () => {
      followBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60
    })
  })
}
function scrollToBottom() {
  if (!followBottom) return
  nextTick(() => {
    const el = document.querySelector('.el-table__body-wrapper')
    if (el) el.scrollTop = el.scrollHeight
  })
}

async function saveConfig() {
  try { await window.gitReport.configSave(toPlain(config.value)) } catch { /* noop */ }
}

async function browseRoot() {
  const dir = await window.gitReport.pickDirectory()
  if (dir && !config.value.roots.includes(dir)) {
    config.value.roots.push(dir)
    newRoot.value = ''
    saveConfig()
  }
}
function addRoot() {
  const v = newRoot.value.trim()
  if (v && !config.value.roots.includes(v)) {
    config.value.roots.push(v)
    saveConfig()
  }
  newRoot.value = ''
}
function removeRoot(i) {
  config.value.roots.splice(i, 1)
  saveConfig()
}

async function doScan() {
  if (!config.value.roots.length) {
    ElMessage.warning('请先添加至少一个扫描根目录')
    return
  }
  // 重置状态：清空表格与队列，准备流式接收
  state.discoveredRepos.length = 0
  state.selectedRepoPaths = []
  selectedRows.value = []
  infoQueue = []
  infoWorkers = []
  followBottom = true
  scrollAttached = false
  scanning.value = true
  progressText.value = '开始扫描…'
  ensureInfoWorkers()
  attachScrollListener()
  try {
    // 仓库通过 scanRepoFound 事件流式追加，此处等待扫描结束
    await window.gitReport.scanRepos(toPlain(config.value.roots), toPlain(config.value.excludes))
  } catch (e) {
    console.error('扫描失败', e)
    scanning.value = false
  }
}

function onSelectionChange(rows) {
  selectedRows.value = rows
  if (!restoring) state.selectedRepoPaths = rows.map((r) => r.path)
}
function selectAll() {
  state.discoveredRepos.forEach((row) => tableRef.value?.toggleRowSelection(row, true))
}

function useSelected() {
  state.repos = selectedRows.value.map((r) => r.path)
  ElMessage.success(`已选择 ${state.repos.length} 个项目，可前往「报告生成」`)
}
</script>
