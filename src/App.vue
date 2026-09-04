<template>
  <div class="app-shell">
    <AppSidebar v-model="view" />
    <section class="shell-main">
      <AppTopbar
        :projects="state.projects.items"
        :current-id="state.projects.currentId"
        @select-project="selectProject"
        @create-project="openProjectEditor()"
      />
      <main class="content-area">
        <transition name="view-fade" mode="out-in">
          <DashboardView v-if="view === 'dashboard'" key="dashboard" @navigate="view = $event" @create-project="openProjectEditor()" />
          <ProjectsView v-else-if="view === 'projects'" key="projects" @navigate="view = $event" @create-project="openProjectEditor()" @edit-project="openProjectEditor" />
          <ChatView v-else-if="view === 'chat'" key="chat" @navigate="view = $event" />
          <ReportView v-else-if="view === 'report'" key="report" @navigate="view = $event" />
          <DeployView v-else-if="view === 'deploy'" key="deploy" @navigate="view = $event" />
          <SettingsView v-else key="settings" />
        </transition>
      </main>
    </section>

    <ProjectEditor v-model:visible="editorVisible" :project="editingProject" @saved="saveEditorProject" />
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import AppSidebar from './components/AppSidebar.vue'
import AppTopbar from './components/AppTopbar.vue'
import ProjectEditor from './components/ProjectEditor.vue'
import DashboardView from './views/DashboardView.vue'
import ProjectsView from './views/ProjectsView.vue'
import ChatView from './views/ChatView.vue'
import ReportView from './views/ReportView.vue'
import DeployView from './views/DeployView.vue'
import SettingsView from './views/SettingsView.vue'
import { state } from './store'
import { useProjects } from './composables/useProjects'
import { toPlain } from './utils/ipc'
import { shortPath, pathKey } from './utils/path'

const view = ref('dashboard')
const editorVisible = ref(false)
const editingProject = ref(null)
const { loadProjects, selectProject, saveProject } = useProjects()

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

/**
 * 一次性提示：把「加为项目」功能上线前已发现的 Git 仓库批量加入项目。
 * 无论用户选择加入还是暂不，都写入 repoImportPrompted 标记，之后不再提示。
 */
async function maybePromptImportRepos(repos) {
  try {
    if (state.config.repoImportPrompted || !Array.isArray(repos) || !repos.length) return
    const added = new Set(state.projects.items.map((p) => pathKey(p.localPath)))
    const candidates = repos.filter((repoPath) => !added.has(pathKey(repoPath)))
    if (!candidates.length) return
    // 先落标记，保证只提示一次（即便提示框未做出选择）
    state.config.repoImportPrompted = true
    await window.gitReport.configSave(toPlain(state.config))
    const names = candidates.slice(0, 5).map((repoPath) => repoPath.replace(/[\\/]+$/, '').split(/[\\/]/).pop())
    const suffix = candidates.length > 5 ? ` 等 ${candidates.length} 个` : ''
    await ElMessageBox.confirm(
      `扫描到的 Git 仓库尚未加入项目：${names.join('、')}${suffix}。是否全部加为项目？（也可稍后在「设置 → Git 活动」中逐个加入）`,
      '把仓库加入项目？',
      { type: 'info', confirmButtonText: '全部加为项目', cancelButtonText: '暂不' }
    )
    for (const repoPath of candidates) {
      const name = repoPath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '未命名项目'
      await window.gitReport.projectsSave(toPlain({ name, localPath: repoPath }))
    }
    await loadProjects()
    ElMessage.success(`已加入 ${candidates.length} 个项目`)
  } catch { /* 用户选择「暂不」或保存配置失败：不再提示 */ }
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

    window.gitReport.onScanProgress((progress) => { state.report.scanProgress = progress })
    window.gitReport.onCollectProgress((progress) => { state.report.collectProgress = progress })
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
    })
    window.gitReport.onDeployDone((result) => {
      state.deploy.running = false
      if (result?.record?.status === 'success') state.deploy.currentVersion = result.record.version
    })

    window.gitReport.warmup().then((repos) => {
      if (Array.isArray(repos) && repos.length && !state.discoveredRepos.length) {
        state.discoveredRepos = repos.map((path) => ({ path, shortName: shortPath(path), info: null }))
      }
      maybePromptImportRepos(repos)
    }).catch(() => { /* 预热失败时由活动报告和设置页按需扫描。 */ })
  } catch (error) {
    console.error('初始化应用失败', error)
  }
})
</script>
