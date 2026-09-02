/**
 * 无头发布入口 —— 用法: npx electron scripts/deploy-headless.cjs <projectId>
 *
 * 场景：参数已在 GUI 里配置好（密码经 safeStorage 加密保存在 userData），
 * 需要在不打开界面的情况下执行一次完整发布（CI / 脚本化 / 代办）。
 * 复用主进程 deploy 模块与 GUI 完全相同的链路；日志与阶段事件打到 stdout。
 * 退出码：0=发布成功，1=失败/回滚/取消。
 */
const path = require('path')
const { app } = require('electron')

const projectId = process.argv[2]
if (!projectId) {
  console.error('用法: electron scripts/deploy-headless.cjs <projectId>')
  app.exit(1)
}

// 复用 GUI 应用的 userData（部署项目配置、加密凭据、发布历史都在这里）
app.setPath('userData', path.join(app.getPath('appData'), 'git-report-desktop'))

app.whenReady().then(async () => {
  // 延迟 require：history/deploy-projects 在调用时才取 userData 路径，ready 后再加载最稳妥
  const deployService = require('../electron/deploy/deploy-service')
  deployService.setEmitter((ch, payload) => {
    if (ch === 'deploy:log') {
      console.log(`${payload.ts} [${payload.level.toUpperCase()}] ${payload.text}`)
    } else if (ch === 'deploy:stage') {
      console.log(`>> 阶段 ${payload.stage}: ${payload.status}`)
    } else if (ch === 'deploy:progress') {
      if (payload.kind === 'upload') process.stdout.write(`\r上传进度 ${payload.percent}%`)
      if (payload.kind === 'package' && payload.count % 50 === 0) process.stdout.write(`\r打包文件数 ${payload.count}`)
    } else if (ch === 'deploy:done') {
      const r = payload.record
      console.log(`\n== 发布结束: ${r.status} | 版本 ${r.version} | 耗时 ${(r.durationMs / 1000).toFixed(1)}s ==`)
      console.log(`== 说明: ${r.message} | 历史日志: ${r.logFile} ==`)
    }
  })

  try {
    const record = await deployService.run(projectId)
    console.log('FINAL_STATUS=' + record.status)
    app.exit(record.status === 'success' ? 0 : 1)
  } catch (e) {
    console.error('发布异常:', e.message)
    app.exit(1)
  }
})
