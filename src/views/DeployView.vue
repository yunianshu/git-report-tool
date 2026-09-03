<template>
  <div class="deploy-page">
    <!-- 项目选择 / 操作条 -->
    <el-card shadow="never" class="card bar-card">
      <div class="bar">
        <span class="bar-label">部署项目</span>
        <el-select
          v-model="state.deploy.currentProjectId"
          placeholder="选择项目（或新建）"
          style="width: 200px"
          @change="onSelectProject"
        >
          <el-option v-for="p in state.deploy.projects" :key="p.id" :value="p.id" :label="p.name || '未命名项目'" />
        </el-select>
        <el-button @click="newProject"><el-icon><Plus /></el-icon>新建</el-button>
        <el-button type="primary" plain @click="saveProject" :disabled="!form.name">
          <el-icon><Check /></el-icon>保存配置
        </el-button>
        <el-button type="danger" plain @click="removeProject" :disabled="!form.id">
          <el-icon><Delete /></el-icon>删除
        </el-button>
        <div class="spacer" />
        <el-tag v-if="dirty" type="warning" effect="plain" size="small">有未保存修改</el-tag>
        <el-button @click="testConnection" :loading="testing" :disabled="!form.id || dirty">
          <el-icon><Link /></el-icon>测试连接
        </el-button>
      </div>
      <el-alert v-if="connResult" :type="connResult.ok ? 'success' : 'error'" :closable="true" class="conn-alert" @close="connResult = null">
        <template #title>
          <span v-if="connResult.ok">
            连接成功 · Docker: {{ connResult.docker || '未安装' }} · Compose: {{ connResult.compose || '未安装' }} ·
            unzip: {{ connResult.unzip || '未安装' }} · 根分区已用 {{ connResult.disk || '未知' }}
          </span>
          <span v-else>连接失败：{{ connResult.error }}</span>
        </template>
      </el-alert>
    </el-card>

    <el-row :gutter="14">
      <!-- ══════════ 左列：项目配置 ══════════ -->
      <el-col :span="10">
        <el-card shadow="never" class="card">
          <template #header><div class="card-header"><span>基本信息</span></div></template>
          <div class="f-row">
            <span class="f-label">项目名称</span>
            <el-input v-model="form.name" placeholder="如 myapp" style="flex: 1" />
          </div>
          <div class="f-row">
            <span class="f-label">本地目录</span>
            <el-input v-model="form.localPath" placeholder="D:\projects\myapp" style="flex: 1" />
            <el-button @click="browseLocal"><el-icon><Folder /></el-icon></el-button>
          </div>
          <div class="f-row">
            <span class="f-label">Compose</span>
            <el-input v-model="form.composeFile" placeholder="docker-compose.yml" style="flex: 1" />
          </div>
          <div class="f-row">
            <span class="f-label">版本号</span>
            <el-radio-group v-model="form.version.strategy" size="small">
              <el-radio-button value="auto">自动识别</el-radio-button>
              <el-radio-button value="manual">手动指定</el-radio-button>
            </el-radio-group>
            <el-input
              v-if="form.version.strategy === 'manual'"
              v-model="form.version.manual"
              placeholder="如 1.2.3"
              style="width: 140px"
            />
            <el-tag v-else-if="detected.version" type="success" effect="plain" size="small">
              {{ detected.version }}（{{ detected.source }}）
            </el-tag>
            <el-tag v-else type="info" effect="plain" size="small">未识别到版本号</el-tag>
          </div>
          <div class="f-hint">自动识别优先级：VERSION → package.json → pom.xml → build.gradle → pubspec.yaml → *.csproj</div>
        </el-card>

        <!-- 部署目标（多环境） -->
        <el-card shadow="never" class="card">
          <template #header>
            <div class="card-header">
              <span>部署目标（多环境）</span>
              <span class="target-ops">
                <el-button text size="small" type="primary" @click="addTarget"><el-icon><Plus /></el-icon>新增环境</el-button>
                <el-button text size="small" :disabled="!activeTarget" @click="renameTarget">重命名</el-button>
                <el-button text size="small" type="danger" :disabled="form.targets.length <= 1" @click="removeTarget">删除</el-button>
              </span>
            </div>
          </template>
          <div class="target-row">
            <el-select v-model="activeTargetId" style="width: 220px" placeholder="选择部署目标">
              <el-option v-for="t in form.targets" :key="t.id" :value="t.id" :label="t.name || '未命名环境'" />
            </el-select>
            <span v-if="activeTarget" class="target-host mono">
              {{ activeTarget.server.host || '未配置主机' }} → {{ activeTarget.remotePath || '未配置部署目录' }}
            </span>
          </div>
          <div class="f-hint">
            同一项目可配置多个部署目标（测试 / 生产 / 多台服务器），各自独立保存服务器地址、部署目录、
            健康检查与凭据；发布、测试连接、回滚均作用于当前选中的目标。
          </div>
        </el-card>

        <el-card shadow="never" class="card">
          <template #header>
            <div class="card-header"><span>服务器（当前目标）</span></div>
          </template>
          <template v-if="activeTarget">
            <div class="f-row">
              <span class="f-label">主机地址</span>
              <el-input v-model="activeTarget.server.host" placeholder="192.168.1.100 或 server.example.com" style="flex: 1" />
              <el-input-number v-model="activeTarget.server.port" :min="1" :max="65535" controls-position="right" style="width: 100px" />
            </div>
            <div class="f-row">
              <span class="f-label">用户名</span>
              <el-input v-model="activeTarget.server.username" placeholder="root" style="width: 200px" />
              <el-radio-group v-model="activeTarget.server.authType" size="small">
                <el-radio-button value="password">密码</el-radio-button>
                <el-radio-button value="key">私钥</el-radio-button>
              </el-radio-group>
            </div>
            <div v-if="activeTarget.server.authType === 'password'" class="f-row">
              <span class="f-label">密码</span>
              <el-input
                v-model="activeTarget.server.secret"
                type="password"
                show-password
                style="flex: 1"
                :placeholder="activeTarget.server.secretConfigured ? `${activeTarget.server.secretMasked}（留空保持不变）` : 'SSH 登录密码'"
              />
              <el-button v-if="activeTarget.server.secretConfigured" text type="danger" size="small" @click="activeTarget.server.clearSecret = true">
                清除
              </el-button>
            </div>
            <template v-else>
              <div class="f-row">
                <span class="f-label">私钥路径</span>
                <el-input v-model="activeTarget.server.keyPath" placeholder="C:\Users\you\.ssh\id_rsa" style="flex: 1" />
                <el-button @click="browseKey"><el-icon><Folder /></el-icon></el-button>
              </div>
              <div class="f-row">
                <span class="f-label">私钥口令</span>
                <el-input
                  v-model="activeTarget.server.passphrase"
                  type="password"
                  show-password
                  style="flex: 1"
                  :placeholder="activeTarget.server.passphraseConfigured ? '已保存（留空保持不变）' : '无口令可留空'"
                />
              </div>
            </template>
            <div class="f-row">
              <span class="f-label">部署目录</span>
              <el-input v-model="activeTarget.remotePath" placeholder="/opt/apps/myapp" style="flex: 1" />
            </div>
          </template>
          <div class="f-hint">
            远程部署根目录，可自定义；其下自动创建 releases / uploads / backups / shared / deployer，
            current 软链接指向运行版本。密码经系统加密存储，明文不落盘。
          </div>
        </el-card>

        <el-card shadow="never" class="card">
          <template #header><div class="card-header"><span>部署选项</span></div></template>
          <div class="f-row check-row">
            <el-checkbox v-model="form.deploy.backupCode">发布前备份代码</el-checkbox>
            <el-checkbox v-model="form.deploy.autoRollback">失败自动回滚</el-checkbox>
            <el-checkbox v-model="form.deploy.deleteUploadAfterSuccess">成功后删除上传包</el-checkbox>
          </div>
          <div class="f-row check-row">
            <el-checkbox v-model="form.deploy.backupDatabase">发布前备份数据库</el-checkbox>
            <template v-if="form.deploy.backupDatabase">
              <el-select v-model="form.deploy.dbType" style="width: 110px">
                <el-option value="postgres" label="PostgreSQL" />
                <el-option value="mysql" label="MySQL" />
              </el-select>
              <el-input v-model="form.deploy.dbContainer" placeholder="数据库容器名" style="width: 150px" />
              <el-input v-model="form.deploy.dbName" placeholder="库名" style="width: 130px" />
              <el-input v-model="form.deploy.dbUser" placeholder="用户(可选)" style="width: 120px" />
            </template>
          </div>
          <div class="f-row">
            <span class="f-label">保留数量</span>
            <span class="f-mini">最近</span>
            <el-input-number v-model="form.deploy.keepReleases" :min="1" :max="50" controls-position="right" style="width: 90px" />
            <span class="f-mini">个版本 /</span>
            <el-input-number v-model="form.deploy.keepBackups" :min="1" :max="50" controls-position="right" style="width: 90px" />
            <span class="f-mini">份备份</span>
          </div>
        </el-card>

        <el-card shadow="never" class="card">
          <template #header>
            <div class="card-header"><span>健康检查（当前目标）</span></div>
          </template>
          <template v-if="activeTarget">
            <div class="f-row check-row">
              <el-checkbox v-model="activeTarget.health.enabled">启用 HTTP 健康检查</el-checkbox>
            </div>
            <div class="f-row">
              <span class="f-label">检查地址</span>
              <el-input
                v-model="activeTarget.health.url"
                placeholder="http://127.0.0.1:8080/actuator/health"
                style="flex: 1"
                :disabled="!activeTarget.health.enabled"
              />
            </div>
            <div class="f-row">
              <span class="f-label">超时/间隔</span>
              <el-input-number v-model="activeTarget.health.timeout" :min="10" :max="600" controls-position="right" style="width: 100px" :disabled="!activeTarget.health.enabled" />
              <span class="f-mini">秒内，每</span>
              <el-input-number v-model="activeTarget.health.interval" :min="1" :max="30" controls-position="right" style="width: 90px" :disabled="!activeTarget.health.enabled" />
              <span class="f-mini">秒探测一次</span>
            </div>
          </template>
          <div class="f-hint">未启用时仅检查 Docker 容器运行状态。健康检查地址在服务器本机访问，请使用 127.0.0.1。</div>
        </el-card>
      </el-col>

      <!-- ══════════ 右列：发布 / 日志 / 历史 ══════════ -->
      <el-col :span="14">
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
                <el-tag size="small" :type="row.type === 'rollback' ? 'warning' : 'primary'" effect="plain">
                  {{ row.type === 'rollback' ? '回滚' : '发布' }}
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
                  text size="small" type="warning" @click="doRollback(row.version, row.targetId)"
                >回滚</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-col>
    </el-row>

    <!-- 历史日志查看 -->
    <el-dialog v-model="logDialog" title="部署日志" width="860px" top="6vh">
      <pre class="dialog-log">{{ dialogLog || '（无日志内容）' }}</pre>
    </el-dialog>
  </div>
</template>

<script setup>
import { reactive, ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { state } from '../store'

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

function genId() {
  return `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function emptyTarget() {
  return {
    id: genId(),
    name: '环境 1',
    server: {
      host: '', port: 22, username: 'root', authType: 'password', keyPath: '',
      secret: '', clearSecret: false, passphrase: '', clearPassphrase: false,
      secretConfigured: false, secretMasked: '', passphraseConfigured: false,
    },
    remotePath: '',
    health: { enabled: true, url: '', timeout: 90, interval: 3 },
  }
}

function emptyProject() {
  const t = emptyTarget()
  return {
    id: '',
    name: '',
    localPath: '',
    version: { strategy: 'auto', manual: '' },
    composeFile: 'docker-compose.yml',
    deploy: {
      backupCode: true, backupDatabase: false, dbType: 'postgres', dbContainer: '',
      dbName: '', dbUser: '', autoRollback: true, deleteUploadAfterSuccess: true,
      keepReleases: 10, keepBackups: 10,
    },
    targets: [t],
  }
}

const form = reactive(emptyProject())
const activeTargetId = ref('')
const detected = ref({ version: '', source: '' })
const testing = ref(false)
const connResult = ref(null)
const rollingBack = ref(false)
const releases = ref([])
const rollbackVersion = ref('')
const history = ref([])
const logDialog = ref(false)
const dialogLog = ref('')
const logBox = ref(null)
let offDone = null
let detectTimer = null

/** 当前编辑的部署目标（响应式：切换目标后服务器/健康检查卡随之切换） */
const activeTarget = computed(() => {
  const t = form.targets.find((x) => x.id === activeTargetId.value)
  return t || form.targets[0] || null
})

/** 当前选中项目（用于脏检查） */
const selectedRaw = computed(() => state.deploy.projects.find((p) => p.id === state.deploy.currentProjectId) || null)

/** 表单是否与已保存配置不一致（凭据字段不参与比较） */
const dirty = computed(() => {
  if (!form.id || !selectedRaw.value) return false
  const norm = (o) => {
    const c = JSON.parse(JSON.stringify(o))
    for (const t of c.targets || []) {
      const s = t.server || {}
      for (const k of ['secret', 'passphrase', 'clearSecret', 'clearPassphrase', 'secretConfigured', 'secretMasked', 'passphraseConfigured']) delete s[k]
    }
    return JSON.stringify(c)
  }
  return norm(form) !== norm(selectedRaw.value)
})

const publishVersion = computed(() => {
  if (form.version.strategy === 'manual' && form.version.manual) return form.version.manual
  return detected.value.version || ''
})

const canPublish = computed(() => {
  if (state.deploy.running || !form.id || dirty.value || !activeTarget.value) return false
  const t = activeTarget.value
  return !!(form.name && form.localPath && publishVersion.value && t.server.host && t.remotePath)
})

// ─── 数据加载 ───
async function loadProjects() {
  try {
    state.deploy.projects = await window.gitReport.deployProjectsList() || []
  } catch { state.deploy.projects = [] }
  if (!state.deploy.currentProjectId && state.deploy.projects.length) {
    state.deploy.currentProjectId = state.deploy.projects[0].id
    fillForm(state.deploy.projects[0])
  }
}

function fillForm(p) {
  const base = emptyProject()
  const merged = { ...base, ...JSON.parse(JSON.stringify(p || {})) }
  merged.version = { ...base.version, ...(p && p.version || {}) }
  merged.deploy = { ...base.deploy, ...(p && p.deploy || {}) }
  // 目标数组：至少一个；密钥输入框每次填充后清空（留空＝保持已保存的凭据）
  merged.targets = (p && Array.isArray(p.targets) && p.targets.length)
    ? p.targets.map((t) => {
        const et = emptyTarget()
        const server = { ...et.server, ...(t.server || {}) }
        server.secret = ''
        server.passphrase = ''
        server.clearSecret = false
        server.clearPassphrase = false
        return { ...et, ...t, server, health: { ...et.health, ...(t.health || {}) } }
      })
    : base.targets
  Object.assign(form, merged)
  activeTargetId.value = merged.targets[0].id
  detectVersion()
}

function onSelectProject(id) {
  const p = state.deploy.projects.find((x) => x.id === id)
  releases.value = []
  rollbackVersion.value = ''
  connResult.value = null
  state.deploy.currentVersion = ''
  if (p) fillForm(p)
  else { Object.assign(form, emptyProject()); activeTargetId.value = form.targets[0].id }
  loadHistory()
}

function newProject() {
  state.deploy.currentProjectId = ''
  Object.assign(form, emptyProject())
  activeTargetId.value = form.targets[0].id
  detected.value = { version: '', source: '' }
  releases.value = []
  connResult.value = null
}

async function saveProject() {
  if (!form.name) return ElMessage.warning('请填写项目名称')
  const payload = JSON.parse(JSON.stringify(form))
  if (!payload.targets.length) payload.targets = [emptyTarget()]
  // 部署目录留空时按目标随名称自动建议，用户仍可随时修改
  for (const t of payload.targets) {
    if (!t.remotePath && form.name) t.remotePath = `/opt/apps/${form.name}`
  }
  const r = await window.gitReport.deployProjectsSave(payload)
  if (r && r.ok) {
    ElMessage.success('配置已保存')
    await loadProjects()
    state.deploy.currentProjectId = r.id
    const p = state.deploy.projects.find((x) => x.id === r.id)
    if (p) fillForm(p)
  } else {
    ElMessage.error('保存失败')
  }
}

async function removeProject() {
  try {
    await ElMessageBox.confirm(`确认删除项目「${form.name}」？仅删除本地配置，不影响服务器。`, '删除项目', { type: 'warning' })
  } catch { return }
  await window.gitReport.deployProjectsRemove(form.id)
  state.deploy.currentProjectId = ''
  Object.assign(form, emptyProject())
  activeTargetId.value = form.targets[0].id
  await loadProjects()
  ElMessage.success('已删除')
}

// ─── 部署目标（多环境）管理 ───
async function addTarget() {
  const t = emptyTarget()
  t.name = `环境 ${form.targets.length + 1}`
  form.targets.push(t)
  activeTargetId.value = t.id
  connResult.value = null
  ElMessage.success(`已添加「${t.name}」，填写服务器信息后记得保存配置`)
}

async function renameTarget() {
  const t = activeTarget.value
  if (!t) return
  try {
    const { value } = await ElMessageBox.prompt('环境名称（如：测试 / 生产）', '重命名目标', {
      inputValue: t.name, confirmButtonText: '确定', cancelButtonText: '取消',
      inputPattern: /\S+/, inputErrorMessage: '名称不能为空',
    })
    t.name = value.trim()
  } catch { /* 取消 */ }
}

async function removeTarget() {
  const t = activeTarget.value
  if (!t || form.targets.length <= 1) return
  try {
    await ElMessageBox.confirm(
      `确认删除目标「${t.name}」（${t.server.host || '未配置主机'}）？仅删除该环境的配置，不影响服务器。`,
      '删除目标', { type: 'warning' },
    )
  } catch { return }
  const i = form.targets.indexOf(t)
  form.targets.splice(i, 1)
  if (activeTargetId.value === t.id) activeTargetId.value = form.targets[Math.max(0, i - 1)].id
  ElMessage.success('已删除目标')
}

async function browseLocal() {
  const dir = await window.gitReport.pickDirectory()
  if (dir) form.localPath = dir
}
async function browseKey() {
  const dir = await window.gitReport.pickDirectory()
  if (dir && activeTarget.value) activeTarget.value.server.keyPath = dir
}

// ─── 版本识别（防抖） ───
async function detectVersion() {
  if (form.version.strategy === 'manual') return
  if (!form.localPath) { detected.value = { version: '', source: '' }; return }
  try {
    const r = await window.gitReport.deployDetectVersion({ localPath: form.localPath, version: { strategy: 'auto' } })
    detected.value = r || { version: '', source: '' }
  } catch { detected.value = { version: '', source: '' } }
}
watch(() => form.localPath, () => {
  clearTimeout(detectTimer)
  detectTimer = setTimeout(detectVersion, 400)
})

// ─── 连接测试（当前目标） ───
async function testConnection() {
  testing.value = true
  connResult.value = null
  try {
    connResult.value = await window.gitReport.deployTestConnection(form.id, activeTargetId.value)
  } catch (e) {
    connResult.value = { ok: false, error: e.message || String(e) }
  } finally {
    testing.value = false
  }
}

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
  const v = publishVersion.value
  const t = activeTarget.value
  const oldV = state.deploy.currentVersion || '（未知）'
  try {
    await ElMessageBox.confirm(
      `即将发布 ${form.name} ${v} 到【${t.name}】${t.server.host}:${t.remotePath}（当前线上版本 ${oldV}）。发布过程中会备份并自动构建重启，是否继续？`,
      '确认发布',
      { type: 'warning', confirmButtonText: '🚀 发布', cancelButtonText: '取消' },
    )
  } catch { return }
  resetStages()
  state.deploy.running = true
  try {
    const r = await window.gitReport.deployRun(form.id, activeTargetId.value)
    if (r && r.error) ElMessage.error(r.error)
  } catch (e) {
    state.deploy.running = false
    ElMessage.error(e.message || String(e))
  }
  if (!state.deploy.running) loadHistory() // done 事件已关闭 running
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
    const r = await window.gitReport.deployReleases(form.id, activeTargetId.value)
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
  const tid = targetId || activeTargetId.value
  const tName = (form.targets.find((x) => x.id === tid) || {}).name || ''
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
    const r = await window.gitReport.deployRollback(form.id, tid, version)
    if (r && r.ok) {
      ElMessage.success(`已回滚到 ${version}`)
      if (tid === activeTargetId.value) state.deploy.currentVersion = version
    } else if (r && r.error) {
      ElMessage.error(r.error)
    }
  } finally {
    rollingBack.value = false
    state.deploy.running = false
    loadHistory()
  }
}

// ─── 历史 ───
async function loadHistory() {
  try {
    history.value = await window.gitReport.deployHistoryList(form.id || undefined) || []
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
  await window.gitReport.deployHistoryClear(form.id || undefined)
  loadHistory()
}

// ─── 工具 ───
function fmtTime(t) {
  if (!t) return '—'
  const d = new Date(t)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
function fmtDur(ms) {
  if (!ms) return '—'
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}
function statusType(s) {
  return { success: 'success', failed: 'danger', rolled_back: 'warning', canceled: 'info', running: 'primary' }[s] || 'info'
}
function statusText(s) {
  return { success: '成功', failed: '失败', rolled_back: '已回滚', canceled: '已取消', running: '进行中' }[s] || s
}

onMounted(() => {
  loadProjects().then(loadHistory)
  // 发布完成事件：刷新历史 + 结果汇总（App.vue 已更新 running/stages）
  offDone = window.gitReport.onDeployDone(async (d) => {
    loadHistory()
    const r = d && d.record
    if (!r) return
    const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
    const head = `<b>${esc(r.projectName)}</b>${r.targetName ? ` · ${esc(r.targetName)}` : ''} ${esc(r.version)} → ${esc(r.host)}`
    if (r.status === 'success') {
      if (r.targetId === activeTargetId.value) state.deploy.currentVersion = r.version
      await ElMessageBox.alert(
        `${head}<br/>耗时 ${fmtDur(r.durationMs)}<br/><br/>✓ 发布成功`,
        '发布成功',
        { dangerouslyUseHTMLString: true, confirmButtonText: '好的' },
      )
    } else if (r.status === 'failed') {
      await ElMessageBox.alert(
        `${head}<br/>版本 ${esc(r.version)}（原版本 ${esc(r.oldVersion) || '无'}）<br/><br/>✗ 发布失败<br/>${esc(r.message) || ''}`,
        '发布失败',
        { dangerouslyUseHTMLString: true, type: 'error', confirmButtonText: '知道了' },
      )
    } else if (r.status === 'rolled_back') {
      await ElMessageBox.alert(
        `${head}<br/>版本 ${esc(r.version)} 发布失败，已自动回滚到 <b>${esc(r.oldVersion) || '旧版本'}</b>。<br/><br/>原因：${esc(r.message) || ''}`,
        '已自动回滚',
        { dangerouslyUseHTMLString: true, type: 'warning', confirmButtonText: '知道了' },
      )
    } else if (r.status === 'canceled') {
      ElMessage.info('发布已取消')
    }
  })
})

onUnmounted(() => {
  if (offDone) offDone()
  clearTimeout(detectTimer)
})
</script>

<style scoped>
.deploy-page { display: flex; flex-direction: column; gap: 0; }
.bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.bar-label { font-weight: 600; margin-right: 4px; }
.bar .spacer { flex: 1; }
.conn-alert { margin-top: 12px; }

.f-row { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; flex-wrap: wrap; }
.f-row:last-child { margin-bottom: 0; }
.f-label { width: 76px; flex-shrink: 0; font-size: 13px; color: #4a5160; text-align: right; }
.f-mini { font-size: 12.5px; color: var(--brand-text-sub); }
.f-hint { font-size: 12px; color: var(--brand-text-sub); line-height: 1.6; margin-top: 2px; }
.check-row { gap: 16px; }

.target-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.target-host { font-size: 12.5px; color: var(--brand-text-sub); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 420px; }
.target-ops { display: inline-flex; align-items: center; gap: 2px; }

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

.mono { font-family: var(--brand-mono); }
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
