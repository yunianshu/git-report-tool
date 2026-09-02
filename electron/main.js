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
const deployService = require('./deploy/deploy-service')
const deployProjects = require('./deploy/deploy-projects')
const deployHistory = require('./deploy/history')

let mainWindow

/** 向主窗口广播事件（预热等主进程主动任务无 sender，统一走此通道） */
function broadcast(channel, payload) {
  const wc = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null
  if (wc) { try { wc.send(channel, payload) } catch { /* noop */ } }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1080,
    minHeight: 700,
    title: 'Git 报告 · 一键部署',
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

/**
 * 启动预热 —— 把「扫描 + 收集默认范围（今天）」提前到后台执行：
 * 用户点「生成报告」时，仓库列表与今日提交缓存均已就绪，报告近乎即时生成。
 * 幂等：预热进行中/已完成的重复触发直接复用（scanReposCached/collectCommits 内部去重）。
 */
let warmupTask = null
async function warmupPipeline() {
  const task = (async () => {
    const cfg = store.load()
    if (!cfg.roots || !cfg.roots.length) return []
    const repos = await gitService.scanReposCached(cfg.roots, cfg.excludes, {
      onProgress: (p) => broadcast('git:scanProgress', p),
      onRepo: (r) => broadcast('git:scanRepoFound', r),
    })
    if (!repos.length) return repos
    // 预收集「日报=今天」范围（与报告页默认参数一致，可精确命中缓存）
    await gitService.collectCommits(repos, {
      since: gitService.todayLocal(),
      until: gitService.tomorrowLocal(),
      authors: [],
      includeMerges: false,
    }, (p) => broadcast('git:collectProgress', p))
    return repos
  })()
  warmupTask = task.catch(() => { warmupTask = null }) // 失败允许下次触发重试
  return warmupTask
}

function registerIpc() {
  // 配置
  ipcMain.handle('config:load', () => store.load())
  ipcMain.handle('config:save', (_e, cfg) => {
    // 根目录/排除规则变化 → 失效扫描缓存并重新预热（新配置的仓库列表与提交即时就绪）
    const before = store.load()
    const r = store.save(cfg)
    const after = store.load()
    const sig = (c) => JSON.stringify([c.roots || [], (c.excludes || []).slice().sort()])
    if (sig(before) !== sig(after)) {
      gitService.invalidateScanCache()
      warmupPipeline()
    }
    return r
  })

  // 目录选择
  ipcMain.handle('dialog:pickDirectory', async () => {
    const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'] })
    return r.canceled ? null : r.filePaths[0]
  })

  // git 服务
  // 扫描统一走 scanReposCached：同参数并发共享一次扫盘，预热完成后瞬时返回；
  // 进度/发现事件经 broadcast 推送，无论预热还是用户触发，渲染端都能收到进度流
  ipcMain.handle('git:scanRepos', (_e, { roots, excludes, force }) => {
    const onProgress = (p) => broadcast('git:scanProgress', p)
    const onRepo = (r) => broadcast('git:scanRepoFound', r)
    return gitService.scanReposCached(roots, excludes, { force: !!force, onProgress, onRepo })
      .then((result) => {
        broadcast('git:scanDone', { total: result.length })
        return result
      })
  })
  ipcMain.handle('git:repoInfo', (_e, repo) => gitService.getRepoInfo(repo))
  ipcMain.handle('git:collectCommits', async (e, payload) => {
    const onProgress = (p) => { try { e.sender.send('git:collectProgress', p) } catch { /* noop */ } }
    return gitService.collectCommits(payload.repos, payload.opts, onProgress)
  })
  ipcMain.handle('git:identity', () => gitService.getIdentity())

  // 启动预热：渲染端在配置就绪后调用（幂等，主进程启动时也会自动触发），返回预热到的仓库列表
  ipcMain.handle('git:warmup', () => {
    if (!warmupTask) warmupPipeline()
    return warmupTask
  })

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
  ipcMain.handle('ai:models', async (_e, opts) => {
    const o = opts || {}
    try {
      const models = await aiService.listModels({
        baseUrl: o.baseUrl,
        apiKey: o.apiKey || store.getApiKey(),
      })
      return { ok: true, models }
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

  // ─── 一键部署模块（OneDeploy） ───
  deployService.setEmitter((ch, payload) => broadcast(ch, payload))
  ipcMain.handle('deploy:projects:list', () => deployProjects.list())
  ipcMain.handle('deploy:projects:save', (_e, p) => deployProjects.save(p))
  ipcMain.handle('deploy:projects:remove', (_e, id) => deployProjects.remove(id))
  ipcMain.handle('deploy:detectVersion', (_e, project) => deployService.resolveVersion(project || {}))
  ipcMain.handle('deploy:testConnection', async (_e, id) => {
    try {
      const info = await deployService.testConnection(id)
      return { ok: true, ...info }
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) }
    }
  })
  ipcMain.handle('deploy:run', async (_e, id) => {
    try {
      const record = await deployService.run(id)
      return { ok: record.status === 'success', record }
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) }
    }
  })
  ipcMain.handle('deploy:cancel', () => deployService.cancel())
  ipcMain.handle('deploy:releases', async (_e, id) => {
    try {
      const info = await deployService.listReleases(id)
      return { ok: true, ...info }
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) }
    }
  })
  ipcMain.handle('deploy:rollback', async (_e, { projectId, version }) => {
    try {
      const record = await deployService.rollback(projectId, version)
      return { ok: record.status === 'success', record }
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) }
    }
  })
  ipcMain.handle('deploy:history:list', (_e, projectId) => deployHistory.list(projectId))
  ipcMain.handle('deploy:history:readLog', (_e, logFile) => deployHistory.readLog(logFile))
  ipcMain.handle('deploy:history:clear', (_e, projectId) => deployHistory.clear(projectId))
}

app.whenReady().then(() => {
  // 移除默认应用菜单栏（File/Edit/View/Window/Help）
  Menu.setApplicationMenu(null)
  registerIpc()
  createWindow()
  // 启动即后台预热（扫描 + 预收集今天），用户点生成时近乎秒出
  warmupPipeline()
  // 冒烟测试钩子（仅供自动化验证）：设置 SMOKE_EXIT_MS 后自动退出，
  // 并将渲染层 error/warning 控制台消息转发到 stdout 以便断言
  if (process.env.SMOKE_EXIT_MS) {
    const wc = mainWindow.webContents
    wc.on('console-message', (_e, level, message) => {
      if (level >= 2) console.log(`[SMOKE][renderer:${level >= 3 ? 'error' : 'warn'}]`, message)
    })
    wc.on('did-fail-load', (_e, code, desc) => console.log('[SMOKE][did-fail-load]', code, desc))
    // 3 秒后模拟点击「OneDeploy」菜单，验证部署页可正常挂载
    setTimeout(() => {
      wc.executeJavaScript(`(() => {
        const items = [...document.querySelectorAll('.el-menu-item')]
        const target = items.find((e) => e.textContent.includes('OneDeploy'))
        if (target) target.click()
        return items.map((e) => e.textContent.trim())
      })()`).then((menu) => console.log('[SMOKE][menu]', JSON.stringify(menu))).catch((e) => console.log('[SMOKE][click-err]', e.message))
    }, 3000)
    setTimeout(() => app.quit(), Number(process.env.SMOKE_EXIT_MS) || 8000)
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
