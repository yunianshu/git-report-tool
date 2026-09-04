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
const projectService = require('./project-service')
const extensionsService = require('./extensions-service')
const terminalService = require('./terminal-service')
const localDebugService = require('./local-debug-service')
const deployService = require('./deploy/deploy-service')
const deployProjects = require('./deploy/deploy-projects')
const deployHistory = require('./deploy/history')

// 统一数据目录为 ASCII 固定值，与产品显示名（productName，可中文）解耦：
// dev / 打包 GUI / 无头 CLI 三模式共用同一份配置，改名或换产品名不丢数据
app.setPath('userData', process.env.PROJECT_MANAGER_USER_DATA || path.join(app.getPath('appData'), 'dev-project-manager'))

// 一次性迁移：旧版本默认数据目录 %APPDATA%/git-report-desktop（更名前）。
// 仅在新目录还没有任何配置、且未通过 PROJECT_MANAGER_USER_DATA 显式指定数据目录时，
// 把旧数据文件复制过来（复制而非移动，旧目录保留作备份）。
if (!process.env.PROJECT_MANAGER_USER_DATA) {
  try {
    const legacyDir = path.join(app.getPath('appData'), 'git-report-desktop')
    const currentDir = app.getPath('userData')
    const legacyFiles = ['config.json', 'deploy-projects.json', 'deploy-history.json', 'reports.json']
    const legacyDirs = ['reports', 'deploy-logs']
    if (legacyDir !== currentDir && fs.existsSync(path.join(legacyDir, 'config.json')) && !fs.existsSync(path.join(currentDir, 'config.json'))) {
      fs.mkdirSync(currentDir, { recursive: true })
      for (const f of legacyFiles) {
        const src = path.join(legacyDir, f)
        if (fs.existsSync(src)) fs.copyFileSync(src, path.join(currentDir, f))
      }
      for (const d of legacyDirs) {
        const src = path.join(legacyDir, d)
        if (fs.existsSync(src)) fs.cpSync(src, path.join(currentDir, d), { recursive: true })
      }
      console.log('[migrate] 已从旧数据目录 git-report-desktop 迁移配置')
    }
  } catch (e) {
    console.error('[migrate] 旧数据目录迁移失败（不影响启动）', e.message)
  }
}

let mainWindow

/** 向主窗口广播事件（预热等主进程主动任务无 sender，统一走此通道） */
function broadcast(channel, payload) {
  const wc = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null
  if (wc) { try { wc.send(channel, payload) } catch { /* noop */ } }
}

function createWindow() {
  const smokeWidth = Number(process.env.SMOKE_WIDTH) || 1320
  const smokeHeight = Number(process.env.SMOKE_HEIGHT) || 860
  mainWindow = new BrowserWindow({
    width: smokeWidth,
    height: smokeHeight,
    frame: false, // 无边框：原生标题栏隐藏，最小化/最大化/关闭由顶栏自定义按钮承担
    minWidth: 1080,
    minHeight: 700,
    title: '开发项目管理',
    autoHideMenuBar: true,
    backgroundColor: '#f5f7fa',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  // 最大化状态同步给渲染层（自定义标题栏按钮图标切换）
  mainWindow.on('maximize', () => broadcast('win:maximized', true))
  mainWindow.on('unmaximize', () => broadcast('win:maximized', false))

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
  // 窗口控制（无边框窗口的自定义标题栏按钮）
  ipcMain.handle('win:minimize', () => mainWindow && mainWindow.minimize())
  ipcMain.handle('win:toggleMaximize', () => {
    if (!mainWindow) return false
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
    return mainWindow.isMaximized()
  })
  ipcMain.handle('win:close', () => mainWindow && mainWindow.close())
  ipcMain.handle('win:isMaximized', () => !!(mainWindow && mainWindow.isMaximized()))

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

  // 项目中心：项目是 AI、活动报告与部署共享的一等上下文
  ipcMain.handle('projects:list', () => projectService.list())
  ipcMain.handle('projects:save', (_e, project) => projectService.save(project))
  ipcMain.handle('projects:remove', (_e, projectId) => projectService.remove(projectId))

  // 扩展管理：统一管理 Claude Code / Codex / Kimi CLI / Zcode 的技能与插件
  ipcMain.handle('extensions:list', () => extensionsService.listAll())
  ipcMain.handle('extensions:toggleSkill', (_e, { platform, name, enable }) => {
    try {
      return { ok: true, ...extensionsService.toggleSkill(platform, name, enable) }
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) }
    }
  })
  ipcMain.handle('extensions:togglePlugin', (_e, { platform, id, enable }) => {
    try {
      return { ok: true, ...extensionsService.togglePlugin(platform, id, enable) }
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) }
    }
  })
  ipcMain.handle('extensions:readSkill', (_e, { platform, name }) => {
    try {
      return { ok: true, ...extensionsService.readSkillDoc(platform, name) }
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) }
    }
  })

  // 在项目目录打开系统终端（Windows 为 PowerShell）
  ipcMain.handle('terminal:open', (_e, dir) => {
    try {
      // 只回传可克隆字段（child 进程对象不可结构化克隆）
      const { cwd, child } = terminalService.openTerminal(dir)
      return { ok: true, cwd, pid: child?.pid }
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) }
    }
  })

  // 本地调试：探测 / 运行 / 生成项目根目录 start.bat
  ipcMain.handle('debug:status', (_e, dir) => {
    try {
      return { ok: true, ...localDebugService.status(dir) }
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) }
    }
  })
  ipcMain.handle('debug:run', (_e, dir) => {
    try {
      const { cwd, batPath } = localDebugService.run(dir)
      return { ok: true, cwd, batPath }
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) }
    }
  })
  ipcMain.handle('debug:generate', (_e, dir) => {
    try {
      return { ok: true, ...localDebugService.generate(dir) }
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) }
    }
  })

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
  ipcMain.handle('deploy:testConnection', async (_e, { projectId, targetId }) => {
    try {
      const info = await deployService.testConnection(projectId, targetId)
      return { ok: true, ...info }
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) }
    }
  })
  ipcMain.handle('deploy:run', async (_e, { projectId, targetId }) => {
    try {
      const record = await deployService.run(projectId, targetId)
      return { ok: record.status === 'success', record }
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) }
    }
  })
  ipcMain.handle('deploy:cancel', () => deployService.cancel())
  ipcMain.handle('deploy:releases', async (_e, { projectId, targetId }) => {
    try {
      const info = await deployService.listReleases(projectId, targetId)
      return { ok: true, ...info }
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) }
    }
  })
  ipcMain.handle('deploy:rollback', async (_e, { projectId, targetId, version }) => {
    try {
      const record = await deployService.rollback(projectId, version, targetId)
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
    // 点击打开目标视图（SMOKE_VIEW，默认「部署」），验证应用壳与各页面可正常挂载
    setTimeout(() => {
      wc.executeJavaScript(`(() => {
        const items = [...document.querySelectorAll('.el-menu-item')]
        const view = ${JSON.stringify(process.env.SMOKE_VIEW || '部署')}
        const target = items.find((e) => e.textContent.trim() === view)
        if (target) target.click()
        return items.map((e) => e.textContent.trim())
      })()`).then((menu) => console.log('[SMOKE][menu]', JSON.stringify(menu))).catch((e) => console.log('[SMOKE][click-err]', e.message))
    }, Number(process.env.SMOKE_CLICK_MS) || 3000)
    // 调试用：SMOKE_WATCH_MS=间隔 时周期性 dump 内容区根节点 class，观察视图切换过程
    if (process.env.SMOKE_WATCH_MS) {
      const watchTimer = setInterval(() => {
        wc.executeJavaScript(`(() => {
          const kids = [...document.querySelectorAll('.content-area > *')]
          return kids.map((k) => k.className)
        })()`).then((c) => console.log('[SMOKE][watch]', JSON.stringify(c))).catch(() => {})
      }, Number(process.env.SMOKE_WATCH_MS))
      watchTimer.unref?.()
    }
    // 调试用：SMOKE_EVAL=表达式 时在渲染层执行并打印结果（端到端验证 IPC 链路用）
    if (process.env.SMOKE_EVAL) {
      setTimeout(() => {
        wc.executeJavaScript(`(${process.env.SMOKE_EVAL})`).then((r) => console.log('[SMOKE][eval]', JSON.stringify(r))).catch((e) => console.log('[SMOKE][eval-err]', e.message))
      }, Number(process.env.SMOKE_EVAL_MS) || 4000)
    }
    if (process.env.SMOKE_SCREENSHOT_PATH) {
      setTimeout(async () => {
        try {
          const output = path.resolve(process.env.SMOKE_SCREENSHOT_PATH)
          fs.mkdirSync(path.dirname(output), { recursive: true })
          mainWindow.show()
          mainWindow.focus()
          const domInfo = await wc.executeJavaScript(`(() => {
            const root = document.querySelector('.content-area > *')
            return { content: root ? root.className : '(empty)', title: document.querySelector('.content-area h1, .content-area .page-title')?.textContent || '' }
          })()`).catch(() => null)
          if (domInfo) console.log('[SMOKE][dom]', JSON.stringify(domInfo))
          const image = await wc.capturePage()
          if (image.isEmpty()) throw new Error('渲染截图为空')
          fs.writeFileSync(output, image.toPNG())
          console.log('[SMOKE][screenshot]', output)
        } catch (err) {
          console.log('[SMOKE][screenshot-err]', err.message)
        }
      }, Number(process.env.SMOKE_SHOT_MS) || 4500)
    }
    setTimeout(() => app.quit(), Number(process.env.SMOKE_EXIT_MS) || 8000)
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
