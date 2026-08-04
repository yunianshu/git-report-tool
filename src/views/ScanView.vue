<template>
  <div>
    <!-- 扫描配置 -->
    <el-card shadow="never" class="card">
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
          <div class="roots">
            <el-tag v-for="(r, i) in config.roots" :key="r" closable type="info" @close="removeRoot(i)">
              {{ r }}
            </el-tag>
            <el-input
              v-model="newRoot"
              placeholder="输入目录路径，如 D:\AiProject，回车添加"
              style="width: 360px"
              clearable
              @keyup.enter="addRoot"
            />
            <el-button @click="browseRoot"><el-icon><Folder /></el-icon>浏览</el-button>
            <el-button @click="addRoot">添加</el-button>
          </div>
        </el-form-item>

        <el-form-item label="排除目录">
          <div class="excludes">
            <el-checkbox-group v-model="config.excludes">
              <el-checkbox v-for="x in EXCLUDE_PRESETS" :key="x" :value="x">{{ x }}</el-checkbox>
            </el-checkbox-group>
          </div>
        </el-form-item>
      </el-form>
    </el-card>

    <!-- 仓库列表 -->
    <el-card shadow="never" class="card">
      <template #header>
        <div class="card-header">
          <span>发现的 Git 仓库（{{ repos.length }}）</span>
          <div>
            <span v-if="scanning" class="progress-text">{{ progressText }}</span>
            <el-button size="small" :disabled="!repos.length" @click="tableRef?.clearSelection()">清空</el-button>
            <el-button size="small" :disabled="!repos.length" @click="selectAll">全选</el-button>
          </div>
        </div>
      </template>

      <el-table
        ref="tableRef"
        :data="repos"
        height="460"
        size="small"
        v-loading="loadingInfo"
        @selection-change="onSelectionChange"
      >
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

      <div class="footer-actions">
        <el-alert
          v-if="!repos.length && !scanning"
          type="info"
          :closable="false"
          title="添加根目录后点击「开始扫描」发现 Git 仓库，勾选需要的项目即可用于报告生成。"
        />
        <el-button type="primary" :disabled="!selectedRows.length" @click="useSelected">
          使用勾选的 {{ selectedRows.length }} 个项目生成报告
        </el-button>
      </div>
    </el-card>
  </div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { ElMessage } from 'element-plus'
import { state } from '../store'

const EXCLUDE_PRESETS = [
  'node_modules', 'FlutterSDK', 'fvm_cache', '__MACOSX', 'android-sdk', 'jdk', 'Program Files', '.cache',
]

const config = ref({ roots: [], excludes: [], myIdentity: { name: '', email: '' } })
const newRoot = ref('')
const repos = ref([])
const selectedRows = ref([])
const scanning = ref(false)
const loadingInfo = ref(false)
const progressText = ref('')
const tableRef = ref(null)
let unsubScan = null

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
  unsubScan = window.gitReport.onScanProgress((p) => {
    progressText.value = `扫描中… 已处理 ${p.scanned} 个目录（${shortPath(p.current)}）`
  })
})
onBeforeUnmount(() => {
  if (unsubScan) unsubScan()
})

async function saveConfig() {
  try { await window.gitReport.configSave(config.value) } catch { /* noop */ }
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
  if (!config.value.roots.length) return
  scanning.value = true
  progressText.value = '开始扫描…'
  try {
    const paths = await window.gitReport.scanRepos(config.value.roots, config.value.excludes)
    repos.value = paths.map((p) => ({ path: p, shortName: shortPath(p), info: null }))
    selectedRows.value = []
    await loadInfo()
  } catch (e) {
    console.error('扫描失败', e)
  } finally {
    scanning.value = false
  }
}

async function loadInfo() {
  loadingInfo.value = true
  const concurrency = 8
  let i = 0
  const worker = async () => {
    while (i < repos.value.length) {
      const idx = i
      i += 1
      const row = repos.value[idx]
      try {
        row.info = await window.gitReport.repoInfo(row.path)
      } catch {
        row.info = { remote: '-', branch: '-', lastCommit: '-' }
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))
  loadingInfo.value = false
}

function onSelectionChange(rows) {
  selectedRows.value = rows
}
function selectAll() {
  repos.value.forEach((row) => tableRef.value?.toggleRowSelection(row, true))
}

function useSelected() {
  state.repos = selectedRows.value.map((r) => r.path)
  ElMessage.success(`已选择 ${state.repos.length} 个项目，可前往「报告生成」`)
}
</script>
