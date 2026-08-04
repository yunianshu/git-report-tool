/**
 * Preload —— 通过 contextBridge 向渲染进程暴露安全的 IPC API
 */
const { contextBridge, ipcRenderer } = require('electron')

function subscribe(channel, cb) {
  const listener = (_e, payload) => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

contextBridge.exposeInMainWorld('gitReport', {
  // 配置
  configLoad: () => ipcRenderer.invoke('config:load'),
  configSave: (cfg) => ipcRenderer.invoke('config:save', cfg),
  // 目录
  pickDirectory: () => ipcRenderer.invoke('dialog:pickDirectory'),
  // git
  scanRepos: (roots, excludes) => ipcRenderer.invoke('git:scanRepos', { roots, excludes }),
  repoInfo: (repo) => ipcRenderer.invoke('git:repoInfo', repo),
  collectCommits: (repos, opts) => ipcRenderer.invoke('git:collectCommits', { repos, opts }),
  getIdentity: () => ipcRenderer.invoke('git:identity'),
  onScanProgress: (cb) => subscribe('git:scanProgress', cb),
  onCollectProgress: (cb) => subscribe('git:collectProgress', cb),
  // 报告
  saveReport: (defaultName, content) => ipcRenderer.invoke('report:save', { defaultName, content }),
  // 系统
  openPath: (p) => ipcRenderer.invoke('shell:openPath', p),
})
