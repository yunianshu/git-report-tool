<template>
  <div class="settings-page">
    <PageHeader eyebrow="PREFERENCES" title="设置" description="管理 AI 服务、Git 活动采集和个人身份。" />
    <el-segmented v-model="activeSection" :options="SETTING_SECTIONS" class="settings-sections" />

    <!-- Git 活动源：作为工作台入口的直接落点，优先于扫描配置展示 -->
    <el-card v-show="activeSection === 'git'" shadow="never" class="card settings-repo-card">
      <template #header>
        <div class="card-header">
          <span>Git 活动源（{{ state.discoveredRepos.length }}）</span>
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
              <p>暂无活动源，添加扫描根目录后会自动发现 Git 仓库</p>
            </div>
          </template>
          <el-table-column label="活动源" min-width="200" show-overflow-tooltip>
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
          <el-table-column label="操作" width="120" fixed="right">
            <template #default="{ row }">
              <el-button
                v-if="!isRepoAdded(row.path)"
                text
                size="small"
                type="primary"
                :loading="isRepoConverting(row.path)"
                :disabled="isRepoConverting(row.path)"
                @click="convertRepoToProject(row)"
              >
                转换为项目
              </el-button>
              <span v-else class="repo-added-tag">已转换</span>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </el-card>

    <!-- 扫描根目录 -->
    <el-card v-show="activeSection === 'git'" shadow="never" class="card">
      <template #header>
        <div class="card-header"><span>Git 活动采集 · 扫描根目录</span></div>
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
    <el-card v-show="activeSection === 'git'" shadow="never" class="card">
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
    <el-card v-show="activeSection === 'identity'" shadow="never" class="card">
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

    <!-- AI 模型 -->
    <el-card v-show="activeSection === 'ai'" shadow="never" class="card">
      <template #header>
        <div class="card-header"><span>AI 服务</span></div>
      </template>
      <div class="ai-manager">
        <div class="ai-form">
          <div class="ai-row">
            <span class="ai-label">服务商</span>
            <el-select v-model="provider" style="width: 240px" @change="applyPreset">
              <el-option v-for="(p, key) in AI_PRESETS" :key="key" :value="key" :label="p.label" />
            </el-select>
            <span class="ai-hint">选择预设自动填充接口地址与模型，可再手动修改</span>
          </div>
          <div class="ai-row">
            <span class="ai-label">接口地址</span>
            <el-input v-model="state.config.ai.baseUrl" placeholder="https://api.openai.com/v1" style="width: 400px" />
          </div>
          <div class="ai-row">
            <span class="ai-label">API Key</span>
            <el-input
              v-model="apiKeyInput"
              type="password"
              show-password
              :placeholder="state.config.ai.keyConfigured ? `${state.config.ai.keyMasked}（留空保持不变，输入新 Key 替换）` : 'sk-...（未配置）'"
              style="width: 440px"
            />
            <el-button v-if="state.config.ai.keyConfigured" size="small" text type="danger" @click="clearKey">
              <el-icon><Delete /></el-icon>清除密钥
            </el-button>
          </div>
          <div class="ai-row">
            <span class="ai-label">模型名称</span>
            <el-select
              v-model="state.config.ai.model"
              filterable
              allow-create
              default-first-option
              :loading="loadingModels"
              placeholder="选择或输入模型名"
              style="width: 260px"
            >
              <el-option v-for="m in modelOptions" :key="m" :label="m" :value="m" />
            </el-select>
            <el-button size="small" :loading="loadingModels" :disabled="!canFetchModels" @click="fetchModels()">
              <el-icon style="margin-right: 3px"><Refresh /></el-icon>获取模型
            </el-button>
            <span v-if="modelOptions.length" class="ai-hint">共 {{ modelOptions.length }} 个模型</span>
          </div>
          <div class="ai-row">
            <span class="ai-label">温度</span>
            <el-slider v-model="state.config.ai.temperature" :min="0" :max="1" :step="0.1" style="width: 240px" />
            <span class="ai-hint">{{ state.config.ai.temperature }}（越高越有创造性）</span>
          </div>
        </div>
        <div class="ai-actions">
          <el-button type="primary" plain @click="saveConfig">
            <el-icon style="margin-right: 4px"><Check /></el-icon>保存配置
          </el-button>
          <el-button :loading="testing" :disabled="!canTest" @click="testAi">
            <el-icon style="margin-right: 4px"><Connection /></el-icon>测试连接
          </el-button>
          <span v-if="testResult" :class="['ai-result', testResult.ok ? 'ok' : 'err']">
            {{ testResult.ok ? `连接成功：${testResult.reply}` : `连接失败：${testResult.error}` }}
          </span>
        </div>
        <div class="ai-hint ai-note">
          API Key 使用系统安全存储加密后保存在本地，仅本机用于调用模型接口；支持 OpenAI / DeepSeek / Kimi / 通义千问 / Ollama 等兼容接口。配置后，AI 助手可按需读取当前项目资料与活动上下文。
        </div>
      </div>
    </el-card>

    <section v-show="activeSection === 'about'" class="workspace-panel settings-about">
      <span class="section-kicker">LOCAL FIRST</span>
      <h2>个人项目管理</h2>
      <p>项目资料、报告记录和部署配置默认保存在本机。Git、AI 与部署都是按需启用的项目能力。</p>
      <dl class="project-facts">
        <div><dt>版本</dt><dd>{{ appVersion }}</dd></div>
        <div><dt>平台</dt><dd>Windows / macOS / Linux</dd></div>
        <div><dt>数据方式</dt><dd>本地优先</dd></div>
      </dl>
    </section>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { state } from '../store'
import { useProjects } from '../composables/useProjects'
import { toPlain } from '../utils/ipc'
import { shortPath, pathKey } from '../utils/path'
import PageHeader from '../components/PageHeader.vue'

const props = defineProps({
  initialSection: {
    type: String,
    default: 'ai',
    validator: (value) => ['ai', 'git', 'identity', 'about'].includes(value),
  },
})
const { loadProjects } = useProjects()

/** 由 vite define 从 package.json 注入（见 vite.config.js） */
const appVersion = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '—'

const SETTING_SECTIONS = [
  { label: 'AI 服务', value: 'ai' },
  { label: 'Git 活动', value: 'git' },
  { label: '个人身份', value: 'identity' },
  { label: '应用信息', value: 'about' },
]
const activeSection = ref(props.initialSection)

const EXCLUDE_GROUPS = [
  { label: '依赖与构建缓存', items: ['node_modules', '.cache', 'fvm_cache', '.gradle', 'Pods'] },
  { label: 'SDK / 运行时', items: ['FlutterSDK', 'android-sdk', 'androidsdk', 'jdk'] },
  { label: 'IDE / 系统', items: ['.idea', '__MACOSX', 'Program Files'] },
]
const EXCLUDE_PRESETS = EXCLUDE_GROUPS.flatMap((g) => g.items)

const newRoot = ref('')
const scanning = ref(false)
const progressText = ref('')
const convertingRepoKeys = ref([])
const newIdName = ref('')
const newIdEmail = ref('')

// ---------- AI 模型配置 ----------
const AI_PRESETS = {
  openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  deepseek: { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  kimi: { label: 'Kimi（Moonshot）', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  qwen: { label: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  ollama: { label: 'Ollama（本地）', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5' },
  custom: { label: '自定义', baseUrl: '', model: '' },
}
const provider = ref('custom')
const testing = ref(false)
const testResult = ref(null)
/** API Key 输入框（不直接绑定 state.config.ai.apiKey —— 明文 Key 只存主进程） */
const apiKeyInput = ref('')
/** 可用模型列表（从接口 /models 拉取） */
const modelOptions = ref([])
const loadingModels = ref(false)

function maskKey(key) {
  if (!key) return ''
  if (key.length <= 8) return '••••••'
  return `••••••${key.slice(-4)}`
}

function applyPreset(key) {
  const p = AI_PRESETS[key]
  if (p && key !== 'custom') {
    state.config.ai.baseUrl = p.baseUrl
    state.config.ai.model = p.model
  }
  // 切换预设后拉取该接口的可用模型列表（填充下拉）
  fetchModels(false)
}

/** 拉取可用模型列表；showSuccess=false 时静默（启动自动加载场景） */
async function fetchModels(showSuccess = true) {
  if (!state.config.ai.baseUrl || loadingModels.value) return
  loadingModels.value = true
  try {
    const r = await window.gitReport.aiModels(toPlain({
      baseUrl: state.config.ai.baseUrl,
      apiKey: apiKeyInput.value || '',
    }))
    if (r?.ok && r.models?.length) {
      modelOptions.value = r.models
      // 当前模型不在列表中时自动选中第一个可用模型
      if (!r.models.includes(state.config.ai.model)) {
        state.config.ai.model = r.models[0]
      }
      if (showSuccess) ElMessage.success(`获取到 ${r.models.length} 个模型`)
    } else if (showSuccess) {
      ElMessage.error(`获取模型失败：${r?.error || '列表为空'}`)
    }
  } catch (e) {
    if (showSuccess) ElMessage.error(`获取模型失败：${(e && e.message) || e}`)
  } finally {
    loadingModels.value = false
  }
}

const canFetchModels = computed(() => !!(state.config.ai.baseUrl && (state.config.ai.keyConfigured || apiKeyInput.value)))

/** 保存全部配置；AI 密钥：输入了新 Key 则替换，留空则主进程保留既有 */
function saveConfig() {
  if (apiKeyInput.value) {
    state.config.ai.apiKey = apiKeyInput.value
    state.config.ai.keyConfigured = true
    state.config.ai.keyMasked = maskKey(apiKeyInput.value)
    apiKeyInput.value = ''
  } else {
    delete state.config.ai.apiKey
  }
  try { window.gitReport.configSave(toPlain(state.config)) } catch { /* noop */ }
}

async function clearKey() {
  try {
    await ElMessageBox.confirm('确定清除已保存的 API Key 吗？', '清除密钥', { type: 'warning' })
  } catch {
    return
  }
  state.config.ai.clearKey = true
  try { window.gitReport.configSave(toPlain(state.config)) } catch { /* noop */ }
  delete state.config.ai.clearKey
  state.config.ai.keyConfigured = false
  state.config.ai.keyMasked = ''
  apiKeyInput.value = ''
  testResult.value = null
}

const canTest = computed(() => !!(state.config.ai.model && (state.config.ai.keyConfigured || apiKeyInput.value)))

async function testAi() {
  testing.value = true
  testResult.value = null
  try {
    const r = await window.gitReport.aiTest(toPlain({
      baseUrl: state.config.ai.baseUrl,
      apiKey: apiKeyInput.value || '', // 空则主进程使用已存 Key
      model: state.config.ai.model,
    }))
    testResult.value = r
    if (r?.ok) ElMessage.success('连接成功')
    else ElMessage.error(`连接失败：${r?.error || '未知错误'}`)
  } catch (e) {
    testResult.value = { ok: false, error: (e && e.message) || String(e) }
    ElMessage.error(`连接失败：${testResult.value.error}`)
  } finally {
    testing.value = false
  }
}

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
    const key = pathKey(repoPath)
    if (state.discoveredRepos.some((repo) => pathKey(repo.path) === key)) return
    const row = { path: repoPath, shortName: shortPath(repoPath), info: null }
    state.discoveredRepos.push(row)
    infoQueue.push(row)
  })
  unsubScanDone = window.gitReport.onScanDone(() => {
    scanning.value = false
    progressText.value = ''
  })
  // 启动预热已发现的仓库没有详情，进入列表时补充加载远程地址、分支和最近提交。
  infoQueue = state.discoveredRepos.filter((row) => !row.info)
  if (infoQueue.length) ensureInfoWorkers()
  // 已配置 AI 接口时静默拉取模型列表，填充下拉
  if (state.config.ai?.keyConfigured && state.config.ai?.baseUrl) {
    fetchModels(false)
  }
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

async function browseRoot() {
  const dir = await window.gitReport.pickDirectory()
  if (dir && !state.config.roots.includes(dir)) {
    state.config.roots.push(dir)
    saveConfig()
    doScan() // 添加根目录后立即扫描并列出仓库
  }
}
function addRoot() {
  const v = newRoot.value.trim()
  if (v && !state.config.roots.includes(v)) {
    state.config.roots.push(v)
    saveConfig()
    doScan() // 添加根目录后立即扫描并列出仓库
  }
  newRoot.value = ''
}

/** 该仓库是否已加入工作区项目（按 localPath 匹配） */
function isRepoAdded(repoPath) {
  const key = pathKey(repoPath)
  return state.projects.items.some((p) => pathKey(p.localPath) === key)
}
function isRepoConverting(repoPath) {
  return convertingRepoKeys.value.includes(pathKey(repoPath))
}
/** 将单个活动源显式转换为项目；路径锁避免快速点击重复创建。 */
async function convertRepoToProject(row) {
  const key = pathKey(row.path)
  if (!key || isRepoAdded(row.path) || convertingRepoKeys.value.includes(key)) return
  const name = String(row.path).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || row.shortName || '未命名项目'
  convertingRepoKeys.value.push(key)
  try {
    // 保存前再次检查，避免列表状态变化期间重复创建同目录项目。
    if (isRepoAdded(row.path)) return
    const r = await window.gitReport.projectsSave(toPlain({ name, localPath: row.path }))
    if (!r?.ok) throw new Error(r?.error || '保存失败')
    await loadProjects()
    ElMessage.success(`已将活动源「${name}」转换为项目`)
  } catch (e) {
    ElMessage.error(e?.message || '转换项目失败')
  } finally {
    convertingRepoKeys.value = convertingRepoKeys.value.filter((item) => item !== key)
  }
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
    // force=true：绕过主进程扫描缓存强制重扫（事件流式展示 + 更新缓存）
    await window.gitReport.scanRepos(toPlain(state.config.roots), toPlain(state.config.excludes), true)
  } catch (e) {
    console.error('扫描失败', e)
    scanning.value = false
  }
}
</script>
