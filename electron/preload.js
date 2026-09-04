/**
 * Preload —— 通过 contextBridge 向渲染进程暴露安全的 IPC API
 *
 * 关键：Vue 的 ref/reactive 会把数组/对象包装为 Proxy，
 * Electron 的 structuredClone 无法克隆 Proxy，导致 ipcRenderer.invoke
 * 抛出 "An object could not be cloned"。因此在 preload 层将参数统一
 * 转换为普通可克隆对象（JSON 往返），从源头规避该问题。
 */
const { contextBridge, ipcRenderer } = require('electron')

/** 将 Vue 响应式代理等转为普通可 JSON 序列化对象 */
function toPlain(value) {
  if (value === undefined || value === null) return value
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return value
  }
}

function subscribe(channel, cb) {
  const listener = (_e, payload) => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

contextBridge.exposeInMainWorld('gitReport', {
  // 配置
  configLoad: () => ipcRenderer.invoke('config:load'),
  configSave: (cfg) => ipcRenderer.invoke('config:save', toPlain(cfg)),
  // 目录
  pickDirectory: () => ipcRenderer.invoke('dialog:pickDirectory'),
  // git（参数经 toPlain 去除响应式代理）；force=true 强制重新扫盘（手动「重新扫描」用）
  scanRepos: (roots, excludes, force) =>
    ipcRenderer.invoke('git:scanRepos', { roots: toPlain(roots), excludes: toPlain(excludes), force: !!force }),
  warmup: () => ipcRenderer.invoke('git:warmup'),
  repoInfo: (repo) => ipcRenderer.invoke('git:repoInfo', repo),
  collectCommits: (repos, opts) =>
    ipcRenderer.invoke('git:collectCommits', { repos: toPlain(repos), opts: toPlain(opts) }),
  getIdentity: () => ipcRenderer.invoke('git:identity'),
  onScanProgress: (cb) => subscribe('git:scanProgress', cb),
  onScanRepoFound: (cb) => subscribe('git:scanRepoFound', cb),
  onScanDone: (cb) => subscribe('git:scanDone', cb),
  onCollectProgress: (cb) => subscribe('git:collectProgress', cb),
  // 报告
  saveReport: (defaultName, content) => ipcRenderer.invoke('report:save', { defaultName, content }),
  // 报告历史
  saveReportAuto: (payload) => ipcRenderer.invoke('report:saveAuto', toPlain(payload)),
  listHistory: () => ipcRenderer.invoke('report:listHistory'),
  readHistory: (id) => ipcRenderer.invoke('report:readHistory', id),
  deleteHistory: (id) => ipcRenderer.invoke('report:deleteHistory', id),
  // AI 对话（流式）
  aiChat: (messages, opts) =>
    ipcRenderer.invoke('ai:chat', { messages: toPlain(messages), opts: toPlain(opts) }),
  aiStop: () => ipcRenderer.invoke('ai:stop'),
  aiTest: (opts) => ipcRenderer.invoke('ai:test', toPlain(opts)),
  aiModels: (opts) => ipcRenderer.invoke('ai:models', toPlain(opts)),
  onAiDelta: (cb) => subscribe('ai:chatDelta', cb),
  // 系统
  openPath: (p) => ipcRenderer.invoke('shell:openPath', p),
  copyText: (text) => ipcRenderer.invoke('clipboard:write', text),
  readClipboard: () => ipcRenderer.invoke('clipboard:read'),
  // 窗口控制（无边框自定义标题栏）
  winMinimize: () => ipcRenderer.invoke('win:minimize'),
  winToggleMaximize: () => ipcRenderer.invoke('win:toggleMaximize'),
  winClose: () => ipcRenderer.invoke('win:close'),
  winIsMaximized: () => ipcRenderer.invoke('win:isMaximized'),
  onWinMaximized: (cb) => subscribe('win:maximized', cb),
  // 项目中心
  projectsList: () => ipcRenderer.invoke('projects:list'),
  projectsSave: (project) => ipcRenderer.invoke('projects:save', toPlain(project)),
  projectsRemove: (projectId) => ipcRenderer.invoke('projects:remove', projectId),
  // 扩展管理（四平台技能与插件）
  extensionsList: () => ipcRenderer.invoke('extensions:list'),
  extensionsToggleSkill: (platform, name, enable) =>
    ipcRenderer.invoke('extensions:toggleSkill', { platform, name, enable }),
  extensionsTogglePlugin: (platform, id, enable) =>
    ipcRenderer.invoke('extensions:togglePlugin', { platform, id, enable }),
  extensionsReadSkill: (platform, name) =>
    ipcRenderer.invoke('extensions:readSkill', { platform, name }),
  // 终端（在项目目录打开 PowerShell / 系统终端）
  openTerminal: (dir) => ipcRenderer.invoke('terminal:open', dir),
  // ─── 一键部署模块（OneDeploy） ───
  deployProjectsList: () => ipcRenderer.invoke('deploy:projects:list'),
  deployProjectsSave: (p) => ipcRenderer.invoke('deploy:projects:save', toPlain(p)),
  deployProjectsRemove: (id) => ipcRenderer.invoke('deploy:projects:remove', id),
  deployDetectVersion: (project) => ipcRenderer.invoke('deploy:detectVersion', toPlain(project)),
  deployTestConnection: (projectId, targetId) =>
    ipcRenderer.invoke('deploy:testConnection', { projectId, targetId }),
  deployRun: (projectId, targetId) =>
    ipcRenderer.invoke('deploy:run', { projectId, targetId }),
  deployCancel: () => ipcRenderer.invoke('deploy:cancel'),
  deployReleases: (projectId, targetId) =>
    ipcRenderer.invoke('deploy:releases', { projectId, targetId }),
  deployRollback: (projectId, targetId, version) =>
    ipcRenderer.invoke('deploy:rollback', { projectId, targetId, version }),
  deployHistoryList: (projectId) => ipcRenderer.invoke('deploy:history:list', projectId),
  deployHistoryReadLog: (logFile) => ipcRenderer.invoke('deploy:history:readLog', logFile),
  deployHistoryClear: (projectId) => ipcRenderer.invoke('deploy:history:clear', projectId),
  onDeployLog: (cb) => subscribe('deploy:log', cb),
  onDeployStage: (cb) => subscribe('deploy:stage', cb),
  onDeployProgress: (cb) => subscribe('deploy:progress', cb),
  onDeployDone: (cb) => subscribe('deploy:done', cb),
})
