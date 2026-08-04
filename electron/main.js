/**
 * 主进程入口
 */
const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron')
const path = require('path')
const fs = require('fs')
const gitService = require('./git-service')
const store = require('./store')

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
    const onProgress = (p) => { try { e.sender.send('git:scanProgress', p) } catch { /* noop */ } }
    return gitService.scanRepos(roots, excludes, onProgress)
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
