<template>
  <div class="app-shell" :class="{ 'is-immersive': state.ui.fullscreen }">
    <AppSidebar v-if="!state.ui.fullscreen" v-model="view" />
    <section class="shell-main">
      <AppTopbar
        v-if="!state.ui.fullscreen"
        :projects="state.projects.items"
        :current-id="state.projects.currentId"
        @select-project="selectProject"
      />
      <main class="content-area" :class="{ 'content-area--flush': view === 'harness' }">
        <transition name="view-fade" mode="out-in">
          <DashboardView v-if="view === 'dashboard'" key="dashboard" @navigate="navigate" @create-project="openProjectEditor()" />
          <ProjectsView v-else-if="view === 'projects'" key="projects" @navigate="navigate" @create-project="openProjectEditor()" @edit-project="openProjectEditor" />
          <ChatView v-else-if="view === 'chat'" key="chat" @navigate="navigate" />
          <HarnessView v-else-if="view === 'harness'" key="harness" />
          <ReportView v-else-if="view === 'report'" key="report" @navigate="navigate" />
          <FillReportView v-else-if="view === 'fillreport'" key="fillreport" @navigate="navigate" />
          <DeployView v-else-if="view === 'deploy'" key="deploy" @navigate="navigate" />
          <ExtensionsView v-else-if="view === 'extensions'" key="extensions" />
          <SettingsView v-else key="settings" :initial-section="settingsSection" />
        </transition>
      </main>
    </section>

    <ProjectEditor v-model:visible="editorVisible" :project="editingProject" @saved="saveEditorProject" />
  </div>
</template>

<script setup>
import { ref, onMounted, watch } from 'vue'
import { ElMessage } from 'element-plus'
import AppSidebar from './components/AppSidebar.vue'
import AppTopbar from './components/AppTopbar.vue'
import ProjectEditor from './components/ProjectEditor.vue'
import DashboardView from './views/DashboardView.vue'
import ProjectsView from './views/ProjectsView.vue'
import ChatView from './views/ChatView.vue'
import HarnessView from './views/HarnessView.vue'
import ReportView from './views/ReportView.vue'
import FillReportView from './views/FillReportView.vue'
import DeployView from './views/DeployView.vue'
import ExtensionsView from './views/ExtensionsView.vue'
import SettingsView from './views/SettingsView.vue'
import { state } from './store'
import { useProjects } from './composables/useProjects'
import { toPlain } from './utils/ipc'
import { shortPath } from './utils/path'

const view = ref('dashboard')
const settingsSection = ref('ai')
const editorVisible = ref(false)
const editingProject = ref(null)
const { loadProjects, selectProject, saveProject } = useProjects()

/** 将页面导航意图集中映射；活动源列表复用设置页的 Git 活动分区。 */
function navigate(target) {
  if (target === 'activity-sources') {
    settingsSection.value = 'git'
    view.value = 'settings'
    return
  }
  if (target === 'fill-settings') {
    settingsSection.value = 'fill'
    view.value = 'settings'
    return
  }
  view.value = target
}

function openProjectEditor(project = null) {
  editingProject.value = project ? JSON.parse(JSON.stringify(project)) : null
  editorVisible.value = true
}

/** 全屏只属于 Harness 视图：任何原因切走后立即恢复应用外壳（侧栏被隐藏时用户无法自行切走） */
watch(view, (next) => {
  if (next !== 'harness' && state.ui.fullscreen) window.gitReport.winSetFullScreen(false).catch(() => {})
})

async function saveEditorProject(project) {
  try {
    await saveProject(project)
    editorVisible.value = false
    view.value = 'projects'
    ElMessage.success(project.id ? '项目已更新' : '项目已创建')
  } catch (error) {
    ElMessage.error(error?.message || '保存项目失败')
  }
}

onMounted(async () => {
  // 沉浸全屏：窗口全屏状态由主进程维护，渲染层只跟随（F11/Esc 等外部改变同样同步）
  window.gitReport.onWinFullscreen((value) => { state.ui.fullscreen = !!value })
  try { state.ui.fullscreen = !!(await window.gitReport.winIsFullScreen()) } catch { /* 主进程未就绪 */ }

  await loadProjects()
  try {
    const cfg = await window.gitReport.configLoad()
    if (cfg) {
      // 兼容旧版单身份配置。
      if (cfg.myIdentity && (cfg.myIdentity.name || cfg.myIdentity.email) && (!cfg.identities || !cfg.identities.length)) {
        cfg.identities = [cfg.myIdentity]
      }
      if (!cfg.identities || !cfg.identities.length) {
        const identity = await window.gitReport.getIdentity()
        if (identity.name || identity.email) cfg.identities = [identity]
      }
      delete cfg.myIdentity
      if (!Array.isArray(cfg.identities)) cfg.identities = []
      await window.gitReport.configSave(toPlain(cfg))
      state.config = { ...state.config, ...cfg }
    }

    // ─── Git 扫描全局接线：预热与手动扫描的事件都实时反映到工作台 ───
    const pathKey = (p) => String(p || '').replace(/\\/g, '/').toLowerCase()
    /** 用权威仓库路径列表同步发现列表（保留已加载的 info，避免详情重复请求）。
     *  空数组同样生效：根目录被删掉后列表要跟着收缩，否则报告/填报仍会查询已移除的仓库 */
    const syncDiscoveredRepos = (paths) => {
      if (!Array.isArray(paths)) return
      const known = new Map(state.discoveredRepos.map((row) => [pathKey(row.path), row]))
      state.discoveredRepos = paths.map((path) => known.get(pathKey(path)) || { path, shortName: shortPath(path), info: null })
    }
    window.gitReport.onScanProgress((progress) => {
      state.report.scanProgress = progress
      state.scan.scanning = true
      if (progress && progress.scanned) state.scan.scanned = progress.scanned
    })
    window.gitReport.onScanRepoFound((repoPath) => {
      // 发现即入列（按路径去重；设置页手动扫描同样监听，两边互不重复）
      if (!repoPath || state.discoveredRepos.some((repo) => pathKey(repo.path) === pathKey(repoPath))) return
      state.discoveredRepos.push({ path: repoPath, shortName: shortPath(repoPath), info: null })
    })
    window.gitReport.onScanDone(() => {
      state.scan.scanning = false
    })
    let warmupActive = false
    window.gitReport.onCollectProgress((progress) => {
      state.report.collectProgress = progress
      // 仅启动预热的收集才计入工作台进度（报告页生成报告的收集不属于预热）
      if (warmupActive && progress && progress.total) {
        state.scan.collecting = true
        state.scan.collectDone = progress.done || 0
        state.scan.collectTotal = progress.total
      }
    })
    window.gitReport.onDeployLog((log) => {
      state.deploy.logs.push(log)
      if (state.deploy.logs.length > 2000) state.deploy.logs.splice(0, state.deploy.logs.length - 2000)
    })
    window.gitReport.onDeployStage((stage) => {
      const st = state.deploy.stages[stage.stage]
      if (!st) return
      st.status = stage.status
      // 阶段耗时只在结束时由主进程下发（running 事件为 0），用于 chips 上的时间标注
      if (stage.durationMs) st.durationMs = stage.durationMs
    })
    window.gitReport.onDeployProgress((progress) => {
      if (progress.kind === 'package') state.deploy.packageCount = progress.count || 0
      if (progress.kind === 'upload') state.deploy.uploadPercent = progress.percent || 0
      if (progress.kind === 'datasync') state.deploy.datasyncPercent = progress.percent || 0
    })
    window.gitReport.onDeployDone((result) => {
      state.deploy.running = false
      state.deploy.finishedAt = Date.now()
      // 仅发布成功才更新线上版本（回滚/数据恢复的 version 字段不是版本号）
      if (result?.record?.type === 'deploy' && result?.record?.status === 'success') {
        state.deploy.currentVersion = result.record.version
      }
    })

    warmupActive = true
    // 预热早于本组件挂载启动，接线前广播的发现事件已丢失：先用快照补齐，
    // 否则收集期间的「Git 活动源」数量会小于「正在加载今日活动 x/y」的总数
    window.gitReport.reposSnapshot().then(syncDiscoveredRepos).catch(() => {})
    window.gitReport.warmup().then((repos) => {
      warmupActive = false
      state.scan.collecting = false
      // 预热结果为权威列表：按路径合并（保留已有项的 info，补齐事件流可能漏掉的）
      syncDiscoveredRepos(repos)
    }).catch(() => {
      warmupActive = false
      state.scan.collecting = false
    })
  } catch (error) {
    console.error('初始化应用失败', error)
  }
})
</script>
