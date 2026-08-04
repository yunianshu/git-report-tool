/**
 * 将 Vue 响应式代理（ref/reactive 产生的 Proxy）转为普通可 JSON 序列化对象。
 * 必须在调用 window.gitReport.* 前使用——Electron contextBridge/ipcRenderer
 * 无法克隆 Proxy，直接传会抛 "An object could not be cloned" 或挂起。
 */
export function toPlain(value) {
  if (value === undefined || value === null) return value
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return value
  }
}
