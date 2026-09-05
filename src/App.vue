<template>
  <div class="app-shell">
    <AppSidebar v-model="view" />
    <section class="shell-main">
      <AppTopbar
        :projects="state.projects.items"
        :current-id="state.projects.currentId"
        @select-project="selectProject"
      />
      <main class="content-area">
        <transition name="view-fade" mode="out-in">
          <DashboardView v-if="view === 'dashboard'" key="dashboard" @navigate="navigate" @create-project="openProjectEditor()" />
          <ProjectsView v-else-if="view === 'projects'" key="projects" @navigate="navigate" @create-project="openProjectEditor()" @edit-project="openProjectEditor" />
          <ChatView v-else-if="view === 'chat'" key="chat" @navigate="navigate" />
          <ReportView v-else-if="view === 'report'" key="report" @navigate="navigate" />
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
import { ref, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import AppSidebar from './components/AppSidebar.vue'
import AppTopbar from './components/AppTopbar.vue'
import ProjectEditor from './components/ProjectEditor.vue'
import DashboardView from './views/DashboardView.vue'
import ProjectsView from './views/ProjectsView.vue'
import ChatView from './views/ChatView.vue'
import ReportView from './views/ReportView.vue'
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
  view.value = target
}

function openProjectEditor(project = null) {
  editingProject.value = project ? JSON.parse(JSON.stringify(project)) : null
  editorVisible.value = true
}

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
      if (state.deploy.stages[stage.stage]) state.deploy.stages[stage.stage].status = stage.status
    })
    window.gitReport.onDeployProgress((progress) => {
      if (progress.kind === 'package') state.deploy.packageCount = progress.count || 0
      if (progress.kind === 'upload') state.deploy.uploadPercent = progress.percent || 0
      if (progress.kind === 'datasync') state.deploy.datasyncPercent = progress.percent || 0
    })
    window.gitReport.onDeployDone((result) => {
      state.deploy.running = false
      // 仅发布成功才更新线上版本（回滚/数据恢复的 version 字段不是版本号）
      if (result?.record?.type === 'deploy' && result?.record?.status === 'success') {
        state.deploy.currentVersion = result.record.version
      }
    })

    warmupActive = true
    window.gitReport.warmup().then((repos) => {
      warmupActive = false
      state.scan.collecting = false
      // 预热结果为权威列表：按路径合并（保留已有项的 info，补齐事件流可能漏掉的）
      if (Array.isArray(repos) && repos.length) {
        const known = new Map(state.discoveredRepos.map((row) => [pathKey(row.path), row]))
        state.discoveredRepos = repos.map((path) => known.get(pathKey(path)) || { path, shortName: shortPath(path), info: null })
      }
    }).catch(() => {
      warmupActive = false
      state.scan.collecting = false
    })
  } catch (error) {
    console.error('初始化应用失败', error)
  }
})
</script>
