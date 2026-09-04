import { computed } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { state } from '../store'
import { toPlain } from '../utils/ipc'
import { pathKey } from '../utils/path'

const currentProject = computed(() =>
  state.projects.items.find((project) => project.id === state.projects.currentId) || null
)

async function loadProjects({ preserveSelection = true } = {}) {
  if (state.projects.loading) return state.projects.items
  state.projects.loading = true
  const previousId = preserveSelection ? state.projects.currentId : ''
  try {
    const items = await window.gitReport.projectsList()
    state.projects.items = Array.isArray(items) ? items : []
    // 部署模块沿用同一份项目对象，避免两个项目列表产生偏差。
    state.deploy.projects = state.projects.items
    if (previousId && state.projects.items.some((item) => item.id === previousId)) {
      state.projects.currentId = previousId
    } else if (state.projects.currentId && state.projects.items.some((item) => item.id === state.projects.currentId)) {
      // 保持当前选择。
    } else {
      state.projects.currentId = state.projects.items[0]?.id || ''
    }
    state.deploy.currentProjectId = state.projects.currentId
    return state.projects.items
  } catch (error) {
    console.error('加载项目失败', error)
    ElMessage.error('加载项目失败')
    return []
  } finally {
    state.projects.loading = false
  }
}

function selectProject(projectId) {
  state.projects.currentId = projectId || ''
  state.deploy.currentProjectId = state.projects.currentId
}

async function saveProject(project) {
  const result = await window.gitReport.projectsSave(toPlain(project))
  if (!result?.ok) throw new Error(result?.error || '保存项目失败')
  state.projects.currentId = result.id
  await loadProjects()
  return currentProject.value
}

async function removeProject(projectId) {
  const result = await window.gitReport.projectsRemove(projectId)
  if (!result?.ok) throw new Error(result?.error || '删除项目失败')
  if (state.projects.currentId === projectId) state.projects.currentId = ''
  await loadProjects()
}

/**
 * 一次性提示：把扫描发现、但尚未加入项目的 Git 仓库批量加为项目。
 * 启动预热与设置页扫描完成后都会检查；无论用户选择加入还是暂不，
 * 都写入 repoImportPrompted 标记，之后不再提示（可在设置页逐个手动加入）。
 */
async function promptImportDiscoveredRepos(repos) {
  try {
    if (state.config.repoImportPrompted || !Array.isArray(repos) || !repos.length) return
    const added = new Set(state.projects.items.map((p) => pathKey(p.localPath)))
    const candidates = [...new Set(repos)].filter((repoPath) => !added.has(pathKey(repoPath)))
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

export function useProjects() {
  return { currentProject, loadProjects, selectProject, saveProject, removeProject, promptImportDiscoveredRepos }
}
