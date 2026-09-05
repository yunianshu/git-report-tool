/**
 * 报告数据收集 —— 供「AI 聊天」主页与「报告」页共用：
 * 扫描仓库（如有需要）→ 收集指定范围提交到 state.report
 */
import { ElMessage } from 'element-plus'
import { state } from '../store'
import { toPlain } from './ipc.js'
import { shortPath } from './path.js'

/** 确保已发现仓库（无则自动扫描），返回是否就绪 */
export async function ensureRepos() {
  if (state.discoveredRepos.length) return true
  if (!state.config.roots || !state.config.roots.length) {
    ElMessage.warning('请先到「设置」添加扫描根目录')
    return false
  }
  state.report.phase = 'scanning'
  state.report.scanProgress = { scanned: 0 }
  try {
    const paths = await window.gitReport.scanRepos(toPlain(state.config.roots), toPlain(state.config.excludes))
    state.discoveredRepos = paths.map((p) => ({ path: p, shortName: shortPath(p), info: null }))
  } catch (e) {
    console.error('自动扫描失败', e)
    ElMessage.error('扫描仓库失败')
    state.report.phase = 'idle'
    return false
  }
  if (!state.discoveredRepos.length) {
    ElMessage.warning('未扫描到任何 Git 仓库')
    state.report.phase = 'idle'
    return false
  }
  return true
}

/** 收集指定范围提交到 state.report.rawCommits，返回收集条数 */
export async function collectReportData({ since, until, repoPaths } = {}) {
  if (!(await ensureRepos())) return []
  state.report.phase = 'collecting'
  state.report.collectProgress = { done: 0, total: 0 }
  try {
    const allowed = Array.isArray(repoPaths) && repoPaths.length ? new Set(repoPaths) : null
    const repos = state.discoveredRepos.map((r) => r.path).filter((path) => !allowed || allowed.has(path))
    if (!repos.length) {
      state.report.rawCommits = []
      state.report.phase = 'done'
      return []
    }
    const data = await window.gitReport.collectCommits(toPlain(repos), {
      since,
      until,
      authors: [],
      includeMerges: false,
    })
    state.report.rawCommits = data
    state.report.phase = 'done'
    return data
  } catch (e) {
    console.error('收集失败', e)
    ElMessage.error('收集提交失败')
    state.report.phase = 'idle'
    return []
  }
}
