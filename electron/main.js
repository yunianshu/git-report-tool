/**
 * 主进程入口
 */
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, clipboard } = require('electron')
const path = require('path')
const fs = require('fs')
const gitService = require('./git-service')
const store = require('./store')
const reportHistory = require('./report-history')
const aiService = require('./ai-service')

let mainWindow

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1080,
    minHeight: 700,
    title: 'Git 项目报告工具',
    autoHideMenuBar: true,
    backgroundColor: '#f5f7fa',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    mainWindow.loadURL(devUrl)
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }
}

function registerIpc() {
  // 配置
  ipcMain.handle('config:load', () => store.load())
  ipcMain.handle('config:save', (_e, cfg) => store.save(cfg))

  // 目录选择
  ipcMain.handle('dialog:pickDirectory', async () => {
    const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'] })
    return r.canceled ? null : r.filePaths[0]
  })

  // git 服务
  ipcMain.handle('git:scanRepos', async (e, { roots, excludes }) => {
    const wc = e.sender
    const onProgress = (p) => { try { wc.send('git:scanProgress', p) } catch { /* noop */ } }
    // 每发现一个仓库立即推送，实现流式增量展示
    const onRepo = (r) => { try { wc.send('git:scanRepoFound', r) } catch { /* noop */ } }
    const result = await gitService.scanRepos(roots, excludes, onProgress, onRepo)
    try { wc.send('git:scanDone', { total: result.length }) } catch { /* noop */ }
    return result
  })
  ipcMain.handle('git:repoInfo', (_e, repo) => gitService.getRepoInfo(repo))
  ipcMain.handle('git:collectCommits', async (e, payload) => {
    const onProgress = (p) => { try { e.sender.send('git:collectProgress', p) } catch { /* noop */ } }
    return gitService.collectCommits(payload.repos, payload.opts, onProgress)
  })
  ipcMain.handle('git:identity', () => gitService.getIdentity())

  // 报告导出
  ipcMain.handle('report:save', async (_e, { defaultName, content }) => {
    const r = await dialog.showSaveDialog(mainWindow, {
      title: '保存报告',
      defaultPath: path.join(app.getPath('documents'), defaultName),
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    })
    if (r.canceled || !r.filePath) return { saved: false }
    try {
      fs.writeFileSync(r.filePath, content, 'utf8')
      return { saved: true, path: r.filePath }
    } catch (err) {
      return { saved: false, error: err.message }
    }
  })

  // 报告历史
  ipcMain.handle('report:saveAuto', (_e, payload) => reportHistory.save(payload))
  ipcMain.handle('report:listHistory', () => reportHistory.list())
  ipcMain.handle('report:readHistory', (_e, id) => reportHistory.read(id))
  ipcMain.handle('report:deleteHistory', (_e, id) => reportHistory.remove(id))

  // AI 对话（流式）：每个 sender 一个 AbortController 支持停止
  // 安全：明文 API Key 由主进程从 store 解析（getApiKey），渲染层不持有、也不接收
  const aiControllers = new WeakMap()
  ipcMain.handle('ai:chat', async (e, payload) => {
    const { messages, opts } = payload || {}
    const wc = e.sender
    const cfg = store.load()
    const controller = new AbortController()
    aiControllers.set(wc, controller)
    try {
      const full = await aiService.chat({
        baseUrl: (opts && opts.baseUrl) || cfg.ai.baseUrl,
        apiKey: store.getApiKey(), // 忽略渲染层传入的 Key
        model: (opts && opts.model) || cfg.ai.model,
        temperature: opts && opts.temperature !== undefined ? opts.temperature : cfg.ai.temperature,
        messages,
        signal: controller.signal,
        onDelta: (text) => {
          try { wc.send('ai:chatDelta', text) } catch { /* noop */ }
        },
      })
      return { ok: true, text: full }
    } catch (err) {
      if (err && err.name === 'AbortError') return { ok: false, aborted: true, error: '' }
      return { ok: false, error: (err && err.message) || String(err) }
    } finally {
      aiControllers.delete(wc)
    }
  })
  ipcMain.handle('ai:stop', (e) => {
    const c = aiControllers.get(e.sender)
    if (c) { try { c.abort() } catch { /* noop */ } }
    return true
  })
  ipcMain.handle('ai:test', async (_e, opts) => {
    const o = opts || {}
    try {
      return await aiService.test({
        baseUrl: o.baseUrl,
        apiKey: o.apiKey || store.getApiKey(), // 允许测试未保存的新 Key
        model: o.model,
      })
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) }
    }
  })

  // 剪贴板
  ipcMain.handle('clipboard:write', (_e, text) => {
    if (text) clipboard.writeText(String(text))
    return true
  })
  ipcMain.handle('clipboard:read', () => clipboard.readText())

  // 系统
  ipcMain.handle('shell:openPath', (_e, p) => {
    if (p && fs.existsSync(p)) shell.showItemInFolder(p)
  })
}

app.whenReady().then(() => {
  // 移除默认应用菜单栏（File/Edit/View/Window/Help）
  Menu.setApplicationMenu(null)
  registerIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
