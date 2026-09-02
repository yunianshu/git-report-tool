/**
 * 部署编排服务 —— 对应方案 §4/§10/§17/§27 的 DeployService：
 * 完整流程：本地检查 → 生成 ZIP → SSH 连接 → 上传+校验 → 服务器备份 →
 * 解压 → Docker 构建 → 启动 → 健康检查 → （失败自动回滚）→ 清理 → 记录历史。
 * 服务器端逻辑收敛在 deploy.sh（方案 §10.2），本模块只负责编排、日志流与阶段映射。
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const ssh = require('./ssh-service')
const packager = require('./packager')
const projects = require('./deploy-projects')
const history = require('./history')
const { detectVersion } = require('./version-detector')

/** 服务端脚本随应用分发（asar 内也可 readFileSync） */
const DEPLOY_SCRIPT_PATH = path.join(__dirname, 'scripts', 'deploy.sh')

/** 8 个发布阶段（方案 §17），渲染层按此渲染进度 */
const STAGES = [
  { id: 'check', label: '检查项目' },
  { id: 'package', label: '项目打包' },
  { id: 'upload', label: '上传文件' },
  { id: 'backup', label: '备份服务器' },
  { id: 'extract', label: '解压新版本' },
  { id: 'build', label: 'Docker构建' },
  { id: 'start', label: '启动服务' },
  { id: 'health', label: '健康检查' },
]

let emitFn = null
let activeRun = null // { id, conn, canceled }

function setEmitter(fn) {
  emitFn = fn
}

function emit(channel, payload) {
  if (emitFn) { try { emitFn(channel, payload) } catch { /* 窗口销毁时忽略 */ } }
}

function ts() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function log(level, text) {
  emit('deploy:log', { level, text, ts: ts() })
  if (logSink) logSink(level, text)
}

/** 日志落盘钩子：发布/回滚期间由运行任务设置，写历史日志用 */
let logSink = null

/** 阶段状态：running/success/failed/skipped/rollback */
function stage(id, status) {
  emit('deploy:stage', { stage: id, status })
}

function newStageTracker() {
  const state = Object.fromEntries(STAGES.map((s) => [s.id, { status: 'waiting', durationMs: 0 }]))
  const begin = (id) => { if (state[id]) { state[id].status = 'running'; stage(id, 'running') } }
  const end = (id, status, startedAt) => {
    if (state[id]) {
      state[id].status = status
      if (startedAt) state[id].durationMs = Date.now() - startedAt
      stage(id, status)
    }
  }
  return { state, begin, end }
}

/** 判断是否被用户取消（连接被主动关闭后 exec 会抛错，用此区分报错类型） */
function isCanceled() {
  return !!(activeRun && activeRun.canceled)
}

/** 取消当前发布：主动断开 SSH，服务器脚本收到 HUP 后按 --auto-rollback 处理 */
function cancel() {
  if (!activeRun) return { ok: false, error: '当前没有进行中的发布' }
  activeRun.canceled = true
  ssh.close(activeRun.conn)
  return { ok: true }
}

function isBusy() {
  return !!activeRun
}

/** 解析脚本输出的控制标记，返回应显示的行或 null */
function parseMarker(line, tracker, resultBox) {
  const m = line.match(/^__STAGE__:(\w+)$/)
  if (m) {
    const map = {
      'backup-code': 'backup', 'backup-db': 'backup', extract: 'extract',
      build: 'build', start: 'start', health: 'health', rollback: 'rollback',
    }
    const sid = map[m[1]]
    if (sid === 'rollback') {
      resultBox.rolledBack = true
      log('warn', '发布失败，正在自动回滚……')
    } else if (sid) tracker.begin(sid)
    return null
  }
  const okM = line.match(/^__DEPLOY_OK__:(.*)$/)
  if (okM) { resultBox.ok = true; resultBox.message = okM[1] || '发布成功'; return null }
  const failM = line.match(/^__DEPLOY_FAIL__:(.*)$/)
  if (failM) { resultBox.ok = false; resultBox.message = failM[1] || '发布失败'; return null }
  return line
}

/** 将脚本原始输出按行分流：控制标记解析 + 带等级的日志行 */
function pipeScriptOutput(chunk, tracker, resultBox) {
  for (const raw of String(chunk).split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '')
    if (!line) continue
    const display = parseMarker(line, tracker, resultBox)
    if (display === null) continue
    let level = 'info'
    if (/^\[ERROR\]/.test(display)) level = 'error'
    else if (/^\[WARN\]/.test(display)) level = 'warn'
    else if (/^\[OK\]/.test(display)) level = 'success'
    log(level, display)
  }
}

/** 读取随应用分发的 deploy.sh 内容（强制 LF：git autocrlf 可能把工作区文件
 *  检出为 CRLF，Linux bash 遇 \r 会直接语法错误，上传前必须规范化） */
function readDeployScript() {
  return fs.readFileSync(DEPLOY_SCRIPT_PATH, 'utf8').replace(/\r\n/g, '\n')
}

/** 拼装 deploy.sh 参数（服务器目录结构方案 §8：home 下 releases/uploads/backups/shared/deployer） */
function buildDeployArgs(project, pack) {
  const d = project.deploy || {}
  const h = project.health || {}
  const args = [
    'deploy',
    '--app', project.name,
    '--home', project.server.remotePath,
    '--package', pack.fileName,
    '--sha256', pack.sha256,
    '--compose', project.composeFile || 'docker-compose.yml',
  ]
  args.push(d.backupCode ? '--backup-code' : '--no-backup-code')
  if (d.backupDatabase) {
    args.push('--backup-db', '--db-type', d.dbType || 'postgres',
      '--db-container', d.dbContainer || '', '--db-name', d.dbName || '',
      '--db-user', d.dbUser || '')
  } else {
    args.push('--no-backup-db')
  }
  args.push(d.autoRollback ? '--auto-rollback' : '--no-auto-rollback')
  if (h.enabled && h.url) {
    args.push('--health-url', h.url, '--health-timeout', String(h.timeout || 90), '--health-interval', String(h.interval || 3))
  } else {
    args.push('--no-health')
  }
  args.push('--keep-releases', String(d.keepReleases ?? 10), '--keep-backups', String(d.keepBackups ?? 10))
  args.push(d.deleteUploadAfterSuccess ? '--delete-upload' : '--keep-upload')
  return args
}

function quoteArg(v) {
  // 单引号包裹，内部单引号转义，防止服务器端命令注入
  return `'${String(v).replace(/'/g, `'\\''`)}'`
}

/** 生成完整版本号：手动优先，否则自动检测 */
function resolveVersion(project) {
  if (project.version && project.version.strategy === 'manual' && project.version.manual) {
    return { version: String(project.version.manual).trim(), source: '手动输入' }
  }
  const det = detectVersion(project.localPath)
  if (det.version) return det
  return { version: '', source: '' }
}

/** 发布前本地检查（方案 §23 的关键项） */
function preCheckLocal(project, version) {
  const problems = []
  if (!project.name) problems.push('缺少项目名称')
  if (!project.localPath || !fs.existsSync(project.localPath)) problems.push(`本地项目目录不存在: ${project.localPath}`)
  else if (project.composeFile && !fs.existsSync(path.join(project.localPath, project.composeFile))) {
    problems.push(`Docker Compose 文件不存在: ${project.composeFile}`)
  }
  if (!version) problems.push('未识别到版本号（可改用手动输入）')
  const s = project.server || {}
  if (!s.host) problems.push('未配置服务器地址')
  if (!s.remotePath) problems.push('未配置远程部署目录')
  if (s.authType === 'key' && (!s.keyPath || !fs.existsSync(s.keyPath))) problems.push(`SSH 私钥文件不存在: ${s.keyPath}`)
  return problems
}

/**
 * 执行完整发布。所有事件经 emit 推送：
 *   deploy:stage {stage,status} / deploy:log {level,text,ts}
 *   deploy:progress {kind,percent} / deploy:done {record}
 */
async function run(projectId, runOpts) {
  if (activeRun) throw new Error('已有发布任务进行中，请等待完成或取消')
  const list = projects.list()
  const project = list.find((p) => p.id === projectId)
  if (!project) throw new Error('项目配置不存在，请重新保存')
  const creds = projects.getCredentials(projectId)

  const runId = crypto.randomBytes(6).toString('hex')
  const tracker = newStageTracker()
  const resultBox = { ok: false, message: '', rolledBack: false, oldVersion: '' }
  const logBuf = []
  logSink = (level, text) => logBuf.push(`${ts()} [${level.toUpperCase()}] ${text}`)

  const record = {
    id: runId,
    projectId: project.id,
    projectName: project.name,
    type: 'deploy',
    version: '',
    oldVersion: '',
    status: 'running',
    startedAt: Date.now(),
    finishedAt: 0,
    durationMs: 0,
    host: `${project.server.host}:${project.server.port}`,
    remotePath: project.server.remotePath,
    message: '',
    logFile: '',
    stages: tracker.state,
  }

  const finish = (status, message) => {
    record.status = status
    record.message = message || record.message
    record.finishedAt = Date.now()
    record.durationMs = record.finishedAt - record.startedAt
    record.logFile = history.writeLog(runId, logBuf.join('\n'))
    history.add(record)
    activeRun = null
    emit('deploy:done', { record: JSON.parse(JSON.stringify(record)) })
    return JSON.parse(JSON.stringify(record))
  }

  let conn = null
  let pack = null
  activeRun = { id: runId, conn: null, canceled: false }
  const setC = (c) => { if (activeRun) activeRun.conn = c; conn = c }

  try {
    // ── 阶段 1：本地检查 ─────────────────────────────
    tracker.begin('check')
    const t0 = Date.now()
    const ver = resolveVersion(project)
    record.version = ver.version
    const problems = preCheckLocal(project, ver.version)
    if (problems.length) {
      for (const p of problems) log('error', p)
      tracker.end('check', 'failed', t0)
      return finish('failed', problems[0])
    }
    log('info', `开始发布 ${project.name} ${ver.version} → ${project.server.host}`)
    log('success', `项目检查通过（版本来源: ${ver.source}）`)
    tracker.end('check', 'success', t0)

    // ── 阶段 2：生成 ZIP ─────────────────────────────
    tracker.begin('package')
    const t1 = Date.now()
    log('info', '正在生成发布包……')
    pack = await packager.buildPackage({
      projectDir: project.localPath,
      appName: project.name,
      version: ver.version,
      onProgress: (count) => emit('deploy:progress', { kind: 'package', count }),
    })
    log('success', `ZIP 生成完成：${pack.fileName}（${(pack.sizeBytes / 1024 / 1024).toFixed(1)} MB，${pack.fileCount} 个文件）`)
    tracker.end('package', 'success', t1)

    // ── 阶段 3：连接 + 上传 ─────────────────────────
    tracker.begin('upload')
    const t2 = Date.now()
    log('info', `连接服务器 ${project.server.host}:${project.server.port}……`)
    setC(await ssh.connect({
      host: project.server.host,
      port: project.server.port,
      username: project.server.username,
      authType: project.server.authType,
      password: creds.password,
      keyPath: project.server.keyPath,
      passphrase: creds.passphrase,
    }))
    log('success', 'SSH 连接成功')

    const remoteHome = project.server.remotePath
    log('info', '初始化远程目录结构…')
    await ssh.mkdirp(conn, ssh.remoteJoin(remoteHome, 'uploads'))
    await ssh.mkdirp(conn, ssh.remoteJoin(remoteHome, 'deployer'))

    // 上传 deploy.sh（每次覆盖，保证与客户端版本一致）
    const scriptRemote = ssh.remoteJoin(remoteHome, 'deployer', 'deploy.sh')
    log('info', '上传部署脚本…')
    await uploadTextFile(conn, readDeployScript(), scriptRemote)
    log('success', '部署脚本已就绪')

    // 查询当前线上版本（供历史记录与结果展示）
    const cur = await ssh.exec(conn, `readlink ${quoteArg(ssh.remoteJoin(remoteHome, 'current'))} 2>/dev/null || true`)
    resultBox.oldVersion = cur.stdout.trim().split('/').pop() || ''
    record.oldVersion = resultBox.oldVersion
    if (resultBox.oldVersion) log('info', `线上当前版本: ${resultBox.oldVersion}`)

    const zipRemote = ssh.remoteJoin(remoteHome, 'uploads', pack.fileName)
    await ssh.upload(conn, pack.zipPath, zipRemote, (done, total) => {
      emit('deploy:progress', { kind: 'upload', percent: total ? Math.round((done / total) * 100) : 0 })
    })
    log('success', '上传完成，校验文件完整性……')
    const sum = await ssh.exec(conn, `sha256sum ${quoteArg(zipRemote)} | awk '{print $1}'`)
    const remoteSha = (sum.stdout || '').trim()
    if (remoteSha !== pack.sha256) {
      throw new Error(`上传校验失败（本地 ${pack.sha256.slice(0, 8)} / 远端 ${remoteSha.slice(0, 8)}）`)
    }
    log('success', 'SHA256 校验通过')
    tracker.end('upload', 'success', t2)

    // ── 阶段 4~8：服务器端执行 deploy.sh ────────────
    const cmd = `bash ${quoteArg(scriptRemote)} ${buildDeployArgs(project, pack).map(quoteArg).join(' ')}`
    const res = await ssh.exec(conn, cmd, (chunk) => pipeScriptOutput(chunk, tracker, resultBox))

    if (resultBox.ok && res.code === 0) {
      // 补齐脚本未显式标记的阶段为成功（例如未启用健康检查）
      for (const s of ['extract', 'build', 'start']) {
        if (tracker.state[s].status === 'waiting') tracker.end(s, 'success')
      }
      if (tracker.state.health.status === 'waiting') tracker.end('health', 'skipped')
      if (tracker.state.backup.status === 'waiting') tracker.end('backup', 'skipped')
      log('success', `发布成功：${ver.version}`)
      // 成功后删除本地临时 zip
      try { fs.unlinkSync(pack.zipPath) } catch { /* 清理失败不影响结果 */ }
      return finish(resultBox.rolledBack ? 'rolled_back' : 'success', resultBox.message)
    }
    if (isCanceled()) {
      log('warn', '发布已取消，服务器脚本将自动回滚')
      return finish('canceled', '用户取消')
    }
    for (const s of STAGES) {
      if (tracker.state[s.id].status === 'running') tracker.end(s.id, resultBox.rolledBack ? 'rollback' : 'failed')
    }
    log('error', resultBox.message || `部署脚本退出码 ${res.code}`)
    return finish(resultBox.rolledBack ? 'rolled_back' : 'failed', resultBox.message || '发布失败')
  } catch (err) {
    if (isCanceled()) {
      log('warn', '发布已取消')
      return finish('canceled', '用户取消')
    }
    const msg = (err && err.message) || String(err)
    log('error', `发布异常: ${msg}`)
    for (const s of STAGES) {
      if (tracker.state[s.id].status === 'running') tracker.end(s.id, 'failed')
    }
    return finish('failed', msg)
  } finally {
    ssh.close(conn)
    logSink = null
    if (activeRun && activeRun.id === runId) activeRun = null
    // 清理本地残留 zip（失败场景；成功路径已在 finish 前删除）
    try { if (pack && fs.existsSync(pack.zipPath)) fs.unlinkSync(pack.zipPath) } catch { /* noop */ }
  }
}

/** 上传内存文本到远端（用于 deploy.sh 等；asar 内文件需先读内容再写） */
function uploadTextFile(conn, text, remotePath) {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) return reject(err)
      const stream = sftp.createWriteStream(remotePath)
      const done = (fn) => (v) => { sftp.end(); fn(v) } // 及时释放通道
      stream.on('error', done(reject))
      stream.on('close', done(() => resolve(remotePath)))
      stream.end(text, 'utf8')
    })
  })
}

/** 测试连接：返回服务器环境信息（Docker/Compose/unzip/磁盘） */
async function testConnection(projectId) {
  const list = projects.list()
  const project = list.find((p) => p.id === projectId)
  if (!project) throw new Error('项目配置不存在，请先保存')
  const creds = projects.getCredentials(projectId)
  const conn = await ssh.connect({
    host: project.server.host,
    port: project.server.port,
    username: project.server.username,
    authType: project.server.authType,
    password: creds.password,
    keyPath: project.server.keyPath,
    passphrase: creds.passphrase,
  })
  try {
    const cmd = [
      'echo __CONN_OK__',
      'uname -srm',
      'docker --version 2>&1 || echo DOCKER_MISSING',
      'docker compose version 2>&1 || echo COMPOSE_MISSING',
      'unzip -v 2>/dev/null | head -1 || echo UNZIP_MISSING',
      'df -h / | tail -1',
    ].join('; ')
    const res = await ssh.exec(conn, cmd)
    const out = res.stdout || ''
    const grab = (re) => { const m = out.match(re); return m ? m[1].trim() : '' }
    return {
      ok: /__CONN_OK__/.test(out) && res.code === 0,
      os: grab(/__CONN_OK__\s*\n(.+)/),
      docker: /DOCKER_MISSING/.test(out) ? '' : grab(/(Docker version [^\n]+)/),
      compose: /COMPOSE_MISSING/.test(out) ? '' : grab(/(Docker Compose version [^\n]+)/),
      unzip: /UNZIP_MISSING/.test(out) ? '' : '已安装',
      disk: grab(/(\d+%)\s+\/\s*$/m) || grab(/\/\s+(\d+%)$/m),
    }
  } finally {
    ssh.close(conn)
  }
}

/** 服务器 releases 目录列表 + 当前指向（方案 §19/§20 的版本管理基础） */
async function listReleases(projectId) {
  const list = projects.list()
  const project = list.find((p) => p.id === projectId)
  if (!project) throw new Error('项目配置不存在，请先保存')
  const creds = projects.getCredentials(projectId)
  const home = project.server.remotePath
  const conn = await ssh.connect({
    host: project.server.host,
    port: project.server.port,
    username: project.server.username,
    authType: project.server.authType,
    password: creds.password,
    keyPath: project.server.keyPath,
    passphrase: creds.passphrase,
  })
  try {
    const res = await ssh.exec(conn,
      `ls -1 ${quoteArg(ssh.remoteJoin(home, 'releases'))} 2>/dev/null; echo __CUR__$(readlink ${quoteArg(ssh.remoteJoin(home, 'current'))} 2>/dev/null)`)
    const lines = (res.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
    const curIdx = lines.findIndex((l) => l.startsWith('__CUR__'))
    const current = curIdx >= 0 ? lines[curIdx].replace('__CUR__', '').split('/').pop() : ''
    return { releases: lines.slice(0, curIdx < 0 ? lines.length : curIdx).filter(Boolean), current }
  } finally {
    ssh.close(conn)
  }
}

/** 手动回滚到指定版本（方案 §20：直接使用服务器已有 release，不重新上传） */
async function rollback(projectId, version) {
  if (activeRun) throw new Error('已有发布任务进行中')
  const list = projects.list()
  const project = list.find((p) => p.id === projectId)
  if (!project) throw new Error('项目配置不存在')
  const creds = projects.getCredentials(projectId)
  const home = project.server.remotePath
  const h = project.health || {}
  const logBuf = []
  const runId = crypto.randomBytes(6).toString('hex')
  const record = {
    id: runId, projectId: project.id, projectName: project.name, type: 'rollback',
    version, oldVersion: '', status: 'running',
    startedAt: Date.now(), finishedAt: 0, durationMs: 0,
    host: `${project.server.host}:${project.server.port}`, remotePath: home,
    message: '', logFile: '',
  }
  logSink = (level, text) => logBuf.push(`${ts()} [${level.toUpperCase()}] ${text}`)
  log('info', `开始回滚 ${project.name} → ${version}`)
  const finish = (status, message) => {
    record.status = status
    record.message = message || ''
    record.finishedAt = Date.now()
    record.durationMs = record.finishedAt - record.startedAt
    record.logFile = history.writeLog(runId, logBuf.join('\n'))
    history.add(record)
    emit('deploy:done', { record: JSON.parse(JSON.stringify(record)) })
    return JSON.parse(JSON.stringify(record))
  }

  const conn = await ssh.connect({
    host: project.server.host,
    port: project.server.port,
    username: project.server.username,
    authType: project.server.authType,
    password: creds.password,
    keyPath: project.server.keyPath,
    passphrase: creds.passphrase,
  })
  activeRun = { id: runId, conn, canceled: false }
  try {
    await ssh.mkdirp(conn, ssh.remoteJoin(home, 'deployer'))
    const scriptRemote = ssh.remoteJoin(home, 'deployer', 'deploy.sh')
    // 脚本缺失时自动补传（首次接管旧项目也能回滚）
    const has = await ssh.exec(conn, `test -f ${quoteArg(scriptRemote)} && echo Y || echo N`)
    if (!/Y/.test(has.stdout)) {
      await uploadTextFile(conn, readDeployScript(), scriptRemote)
    }
    const args = ['rollback', '--app', project.name, '--home', home, '--version', version]
    if (h.enabled && h.url) {
      args.push('--health-url', h.url, '--health-timeout', String(h.timeout || 90), '--health-interval', String(h.interval || 3))
    } else {
      args.push('--no-health')
    }
    const cmd = `bash ${quoteArg(scriptRemote)} ${args.map(quoteArg).join(' ')}`
    const tracker = newStageTracker()
    const resultBox = { ok: false, message: '', rolledBack: false, oldVersion: '' }
    const res = await ssh.exec(conn, cmd, (chunk) => pipeScriptOutput(chunk, tracker, resultBox))
    if (resultBox.ok && res.code === 0) {
      log('success', `回滚成功，当前版本: ${version}`)
      return finish('success', `回滚到 ${version}`)
    }
    log('error', resultBox.message || `回滚失败（退出码 ${res.code}）`)
    return finish('failed', resultBox.message || '回滚失败')
  } catch (err) {
    const msg = (err && err.message) || String(err)
    log('error', `回滚异常: ${msg}`)
    return finish('failed', msg)
  } finally {
    ssh.close(conn)
    logSink = null
    activeRun = null
  }
}

module.exports = {
  run, cancel, isBusy, testConnection, listReleases, rollback,
  setEmitter, STAGES, resolveVersion,
}
