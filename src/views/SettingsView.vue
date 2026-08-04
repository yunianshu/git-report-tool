<template>
  <div class="settings-page">
    <!-- 扫描根目录 -->
    <el-card shadow="never" class="card">
      <template #header>
        <div class="card-header"><span>扫描根目录</span></div>
      </template>
      <div class="root-manager">
        <div class="root-ops">
          <el-input
            v-model="newRoot"
            placeholder="输入目录路径，如 D:\AiProject，回车添加"
            clearable
            @keyup.enter="addRoot"
          />
          <el-button @click="browseRoot"><el-icon><Folder /></el-icon>浏览</el-button>
          <el-button type="primary" plain @click="addRoot">添加</el-button>
        </div>
        <div v-if="state.config.roots.length" class="root-list">
          <div class="root-list-title">已添加 {{ state.config.roots.length }} 个根目录</div>
          <el-tag
            v-for="(r, i) in state.config.roots"
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
    </el-card>

    <!-- 排除目录 -->
    <el-card shadow="never" class="card">
      <template #header>
        <div class="card-header"><span>排除目录</span></div>
      </template>
      <div class="exclude-manager">
        <div v-for="group in EXCLUDE_GROUPS" :key="group.label" class="exclude-group">
          <div class="exclude-group-label">{{ group.label }}</div>
          <div class="exclude-group-items">
            <el-checkbox
              v-for="x in group.items"
              :key="x"
              v-model="state.config.excludes"
              :value="x"
              border
              class="exclude-check"
            >{{ x }}</el-checkbox>
          </div>
        </div>
        <div class="exclude-hint">勾选的目录在扫描时会自动跳过，减少扫描时间</div>
      </div>
    </el-card>

    <!-- 本人身份 -->
    <el-card shadow="never" class="card">
      <template #header>
        <div class="card-header"><span>本人身份</span></div>
      </template>
      <div class="identity-manager">
        <el-tag
          v-for="(id, i) in (state.config.identities || [])"
          :key="i"
          closable
          type="success"
          class="root-tag"
          @close="removeIdentity(i)"
        >
          <el-icon><User /></el-icon>
          <span>{{ id.name || '未命名' }} &lt;{{ id.email }}&gt;</span>
        </el-tag>
        <el-input v-model="newIdName" placeholder="账号名" style="width: 130px" />
        <el-input v-model="newIdEmail" placeholder="账号邮箱" style="width: 220px" @keyup.enter="addIdentity" />
        <el-button @click="addIdentity">添加账号</el-button>
        <div class="exclude-hint" style="width: 100%">「只看本人」会匹配上面所有账号的提交</div>
      </div>
    </el-card>

    <!-- 已发现仓库 -->
    <el-card shadow="never" class="card settings-repo-card">
      <template #header>
        <div class="card-header">
          <span>已发现仓库（{{ state.discoveredRepos.length }}）</span>
          <div class="header-actions">
            <span v-if="scanning" class="progress-text">{{ progressText }}</span>
            <el-button type="primary" plain :loading="scanning" @click="doScan">
              <el-icon style="margin-right: 4px"><Refresh /></el-icon>重新扫描
            </el-button>
          </div>
        </div>
      </template>
      <div class="table-wrap">
        <el-table :data="state.discoveredRepos" height="100%" size="small">
          <template #empty>
            <div class="table-empty">
              <el-icon><FolderOpened /></el-icon>
              <p>暂无仓库，添加根目录后点击「重新扫描」</p>
            </div>
          </template>
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
    </el-card>
  </div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { ElMessage } from 'element-plus'
import { state } from '../store'
import { toPlain } from '../utils/ipc'
import { shortPath } from '../utils/path'

const EXCLUDE_GROUPS = [
  { label: '依赖与构建缓存', items: ['node_modules', '.cache', 'fvm_cache', '.gradle', 'Pods'] },
  { label: 'SDK / 运行时', items: ['FlutterSDK', 'android-sdk', 'androidsdk', 'jdk'] },
  { label: 'IDE / 系统', items: ['.idea', '__MACOSX', 'Program Files'] },
]
const EXCLUDE_PRESETS = EXCLUDE_GROUPS.flatMap((g) => g.items)

const newRoot = ref('')
const scanning = ref(false)
const progressText = ref('')
const newIdName = ref('')
const newIdEmail = ref('')

// 流式扫描事件
let unsubProgress = null
let unsubRepoFound = null
let unsubScanDone = null

// 仓库信息并发加载池
const INFO_CONCURRENCY = 6
let infoQueue = []
let infoWorkers = []

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

onMounted(() => {
  // 首次启动确保排除目录有默认值（App 已加载 config 到 state.config）
  if (!state.config.excludes || !state.config.excludes.length) {
    state.config.excludes = [...EXCLUDE_PRESETS]
    saveConfig()
  }
  unsubProgress = window.gitReport.onScanProgress((p) => {
    progressText.value = `扫描中… 已处理 ${p.scanned} 个目录`
  })
  unsubRepoFound = window.gitReport.onScanRepoFound((repoPath) => {
    if (!scanning.value) return
    const row = { path: repoPath, shortName: shortPath(repoPath), info: null }
    state.discoveredRepos.push(row)
    infoQueue.push(row)
  })
  unsubScanDone = window.gitReport.onScanDone(() => {
    scanning.value = false
    progressText.value = ''
  })
})
onBeforeUnmount(() => {
  if (unsubProgress) unsubProgress()
  if (unsubRepoFound) unsubRepoFound()
  if (unsubScanDone) unsubScanDone()
})

function ensureInfoWorkers() {
  while (infoWorkers.length < INFO_CONCURRENCY) {
    const worker = (async () => {
      for (;;) {
        const row = infoQueue.shift()
        if (!row) {
          if (!scanning.value) return
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

function saveConfig() {
  try { window.gitReport.configSave(toPlain(state.config)) } catch { /* noop */ }
}

async function browseRoot() {
  const dir = await window.gitReport.pickDirectory()
  if (dir && !state.config.roots.includes(dir)) {
    state.config.roots.push(dir)
    saveConfig()
  }
}
function addRoot() {
  const v = newRoot.value.trim()
  if (v && !state.config.roots.includes(v)) {
    state.config.roots.push(v)
    saveConfig()
  }
  newRoot.value = ''
}
function removeRoot(i) {
  state.config.roots.splice(i, 1)
  saveConfig()
}

/** 本人身份（多账号）管理 */
function addIdentity() {
  const name = newIdName.value.trim()
  const email = newIdEmail.value.trim()
  if (!name && !email) return
  if (!state.config.identities) state.config.identities = []
  if (!state.config.identities.some((i) => i.name === name && i.email === email)) {
    state.config.identities.push({ name, email })
  }
  saveConfig()
  newIdName.value = ''
  newIdEmail.value = ''
}
function removeIdentity(i) {
  state.config.identities.splice(i, 1)
  saveConfig()
}

async function doScan() {
  if (!state.config.roots.length) {
    ElMessage.warning('请先添加至少一个扫描根目录')
    return
  }
  state.discoveredRepos.length = 0
  infoQueue = []
  infoWorkers = []
  scanning.value = true
  progressText.value = '开始扫描…'
  ensureInfoWorkers()
  try {
    await window.gitReport.scanRepos(toPlain(state.config.roots), toPlain(state.config.excludes))
  } catch (e) {
    console.error('扫描失败', e)
    scanning.value = false
  }
}
</script>
