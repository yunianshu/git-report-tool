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
  // git（参数经 toPlain 去除响应式代理）
  scanRepos: (roots, excludes) =>
    ipcRenderer.invoke('git:scanRepos', { roots: toPlain(roots), excludes: toPlain(excludes) }),
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
  // 系统
  openPath: (p) => ipcRenderer.invoke('shell:openPath', p),
})
