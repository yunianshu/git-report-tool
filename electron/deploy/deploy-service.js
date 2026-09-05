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
const store = require('../store')
const { detectVersion } = require('./version-detector')

/** 服务端脚本随应用分发（asar 内也可 readFileSync） */
const DEPLOY_SCRIPT_PATH = path.join(__dirname, 'scripts', 'deploy.sh')

/** 9 个发布阶段，渲染层按此渲染进度；datasync 在发布成功后由客户端执行 */
const STAGES = [
  { id: 'check', label: '检查项目' },
  { id: 'package', label: '项目打包' },
  { id: 'upload', label: '上传文件' },
  { id: 'backup', label: '备份服务器' },
  { id: 'extract', label: '解压新版本' },
  { id: 'build', label: 'Docker构建' },
  { id: 'start', label: '启动服务' },
  { id: 'health', label: '健康检查' },
  { id: 'datasync', label: '数据同步' },
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
function buildDeployArgs(project, target, pack, version) {
  const d = project.deploy || {}
  const h = target.health || {}
  const args = [
    'deploy',
    '--app', project.name,
    '--home', target.remotePath,
    '--package', pack.fileName,
    '--sha256', pack.sha256,
    '--version', version,
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
function preCheckLocal(project, target, version) {
  const problems = []
  if (!project.name) problems.push('缺少项目名称')
  if (!project.localPath || !fs.existsSync(project.localPath)) problems.push(`本地项目目录不存在: ${project.localPath}`)
  else if (project.composeFile && !fs.existsSync(path.join(project.localPath, project.composeFile))) {
    problems.push(`Docker Compose 文件不存在: ${project.composeFile}`)
  }
  if (!version) problems.push('未识别到版本号（可改用手动输入）')
  const s = target.server || {}
  if (!s.host) problems.push(`[${target.name}] 未配置服务器地址`)
  if (!target.remotePath) problems.push(`[${target.name}] 未配置远程部署目录`)
  if (s.authType === 'key' && (!s.keyPath || !fs.existsSync(s.keyPath))) problems.push(`[${target.name}] SSH 私钥文件不存在: ${s.keyPath}`)
  return problems
}

/** 从项目取部署目标（targetId 省略时用第一个目标） */
function getTarget(project, targetId) {
  const targets = Array.isArray(project.targets) ? project.targets : []
  return targets.find((t) => t.id === targetId) || targets[0]
}

/** 解析目标的数据同步配置（缺省关闭） */
function getDataSync(target) {
  const s = (target && target.dataSync) || {}
  return {
    enabled: s.enabled === true,
    localDir: String(s.localDir || 'data').trim(),
    remoteDir: String(s.remoteDir || 'shared/data').trim(),
  }
}

/**
 * 校验数据同步配置与本地数据目录。
 * 返回 { ok, sourceDir, problem }：ok=false 时 problem 为用户可读原因。
 */
function validateDataSync(project, dataSync) {
  if (!dataSync.localDir) return { ok: false, problem: '数据目录未填写' }
  const sourceDir = path.resolve(project.localPath, dataSync.localDir)
  // 防越界：数据目录必须位于项目目录内（resolve 后前缀校验）
  const projectRoot = path.resolve(project.localPath)
  if (sourceDir !== projectRoot && !sourceDir.startsWith(projectRoot + path.sep)) {
    return { ok: false, problem: `数据目录必须在项目目录内: ${dataSync.localDir}` }
  }
  if (sourceDir === projectRoot) {
    return { ok: false, problem: '数据目录不能是项目根目录本身' }
  }
  if (!fs.existsSync(sourceDir)) return { ok: false, problem: `数据目录不存在: ${sourceDir}` }
  if (!fs.statSync(sourceDir).isDirectory()) return { ok: false, problem: `数据目录不是文件夹: ${sourceDir}` }
  if (!dataSync.remoteDir || dataSync.remoteDir.includes('..')) {
    return { ok: false, problem: `远程数据目录非法: ${dataSync.remoteDir}` }
  }
  return { ok: true, sourceDir }
}

/** 服务器端数据同步命令：建目录 → 解压覆盖 → 删包（单条命令，任一步失败整体失败） */
function buildDataSyncCommand(dataZipRemote, remoteDestDir) {
  return `mkdir -p ${quoteArg(remoteDestDir)} && unzip -o ${quoteArg(dataZipRemote)} -d ${quoteArg(remoteDestDir)} && rm -f ${quoteArg(dataZipRemote)} && echo __DATA_SYNC_OK__`
}

/** 解析目标的数据导入钩子配置（凭据经 getDataSyncCredentials 从原始数据解密，list() 脱敏版不含） */
function getDataImport(projectId, target, targetId) {
  const s = (target && target.dataSync) || {}
  return {
    mode: s.importMode === 'command' ? 'command' : 'none',
    command: String(s.importCommand || ''),
    user: String(s.importUser || ''),
    secret: projectId ? projects.getDataSyncCredentials(projectId, targetId) : '',
  }
}

/**
 * 展开导入命令占位符：{dataDir}=远端数据目录 {user}/{secret}=应用账号凭据。
 * 替换值按 POSIX 单引号规则转义，防止凭据/路径中的特殊字符破坏命令结构。
 */
function renderImportCommand(command, { dataDir, user, secret }) {
  const shQuote = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`
  return String(command || '')
    .replaceAll('{dataDir}', shQuote(dataDir))
    .replaceAll('{user}', shQuote(user))
    .replaceAll('{secret}', shQuote(secret))
}

/**
 * 执行完整发布（按部署目标）。所有事件经 emit 推送：
 *   deploy:stage {stage,status} / deploy:log {level,text,ts}
 *   deploy:progress {kind,percent} / deploy:done {record}
 */
async function run(projectId, targetId) {
  if (activeRun) throw new Error('已有发布任务进行中，请等待完成或取消')
  const list = projects.list()
  const project = list.find((p) => p.id === projectId)
  if (!project) throw new Error('项目配置不存在，请重新保存')
  const target = getTarget(project, targetId)
  if (!target) throw new Error('项目缺少部署目标，请先在配置中添加')
  const creds = projects.getCredentials(projectId, target.id) || { password: '', passphrase: '' }

  const runId = crypto.randomBytes(6).toString('hex')
  const tracker = newStageTracker()
  const resultBox = { ok: false, message: '', rolledBack: false, oldVersion: '' }
  const logBuf = []
  logSink = (level, text) => logBuf.push(`${ts()} [${level.toUpperCase()}] ${text}`)

  const record = {
    id: runId,
    projectId: project.id,
    projectName: project.name,
    targetId: target.id,
    targetName: target.name,
    type: 'deploy',
    version: '',
    oldVersion: '',
    status: 'running',
    startedAt: Date.now(),
    finishedAt: 0,
    durationMs: 0,
    host: `${target.server.host}:${target.server.port}`,
    remotePath: target.remotePath,
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
    const problems = preCheckLocal(project, target, ver.version)
    if (problems.length) {
      for (const p of problems) log('error', p)
      tracker.end('check', 'failed', t0)
      return finish('failed', problems[0])
    }
    // 数据同步前置校验：目录缺失等问题在检查阶段就失败，避免发布到一半才发现
    const dataSyncCfg = getDataSync(target)
    if (dataSyncCfg.enabled) {
      const vds = validateDataSync(project, dataSyncCfg)
      if (!vds.ok) {
        const msg = `[数据同步] ${vds.problem}`
        log('error', msg)
        tracker.end('check', 'failed', t0)
        return finish('failed', msg)
      }
      log('info', `数据同步已启用：${dataSyncCfg.localDir} → ${dataSyncCfg.remoteDir}`)
    }
    log('info', `开始发布 ${project.name} ${ver.version} → ${target.name}（${target.server.host}）`)
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
    log('info', `连接服务器 ${target.server.host}:${target.server.port}……`)
    setC(await ssh.connect({
      host: target.server.host,
      port: target.server.port,
      username: target.server.username,
      authType: target.server.authType,
      password: creds.password,
      keyPath: target.server.keyPath,
      passphrase: creds.passphrase,
    }))
    log('success', 'SSH 连接成功')

    const remoteHome = target.remotePath
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
    const cmd = `bash ${quoteArg(scriptRemote)} ${buildDeployArgs(project, target, pack, ver.version).map(quoteArg).join(' ')}`
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

      // ── 阶段 9：数据同步（可选，发布成功后推送本地数据到服务器共享目录） ──
      if (dataSyncCfg.enabled && !resultBox.rolledBack) {
        tracker.begin('datasync')
        const tds = Date.now()
        try {
          const vds = validateDataSync(project, dataSyncCfg)
          if (!vds.ok) throw new Error(vds.problem)
          log('info', `正在打包数据目录 ${dataSyncCfg.localDir} ……`)
          const dataPack = await packager.buildDataPackage({
            projectDir: project.localPath,
            dataDir: dataSyncCfg.localDir,
            appName: project.name,
            version: ver.version,
          })
          log('info', `数据包 ${dataPack.fileName}（${dataPack.fileCount} 项，${(dataPack.sizeBytes / 1024 / 1024).toFixed(1)} MB）`)
          const dataZipRemote = ssh.remoteJoin(remoteHome, 'uploads', dataPack.fileName)
          await ssh.upload(conn, dataPack.zipPath, dataZipRemote, (done, total) => {
            emit('deploy:progress', { kind: 'datasync', percent: total ? Math.round((done / total) * 100) : 0 })
          })
          const dsum = await ssh.exec(conn, `sha256sum ${quoteArg(dataZipRemote)} | awk '{print $1}'`)
          if ((dsum.stdout || '').trim() !== dataPack.sha256) {
            throw new Error('数据包上传校验失败（SHA256 不一致）')
          }
          const destDir = ssh.remoteJoin(remoteHome, dataSyncCfg.remoteDir)
          log('info', `解压覆盖到 ${dataSyncCfg.remoteDir} ……`)
          const dres = await ssh.exec(conn, buildDataSyncCommand(dataZipRemote, destDir))
          if (dres.code !== 0 || !/__DATA_SYNC_OK__/.test(dres.stdout || '')) {
            throw new Error(`服务器执行数据同步失败（退出码 ${dres.code}）`)
          }
          // ── 同步后导入钩子：把数据写入应用（如调用应用导入接口） ──
          const di = getDataImport(projectId, target, target.id)
          if (di.mode === 'command' && di.command.trim()) {
            log('info', '执行数据导入命令……')
            const finalCmd = renderImportCommand(di.command, { dataDir: destDir, user: di.user, secret: di.secret })
            const ires = await ssh.exec(conn, finalCmd, (chunk) => {
              for (const line of String(chunk).split(/\r?\n/)) {
                if (line.trim()) log('info', `[导入] ${line.replace(/\s+$/, '')}`)
              }
            })
            if (ires.code !== 0) {
              throw new Error(`数据导入命令执行失败（退出码 ${ires.code}），详见日志`)
            }
            log('success', '数据导入完成')
          }
          try { fs.unlinkSync(dataPack.zipPath) } catch { /* noop */ }
          tracker.end('datasync', 'success', tds)
          log('success', `数据同步完成 → ${dataSyncCfg.remoteDir}`)
        } catch (dsErr) {
          tracker.end('datasync', 'failed', tds)
          const msg = `数据同步失败: ${(dsErr && dsErr.message) || dsErr}`
          log('error', msg)
          log('warn', '代码已发布成功但数据未同步，请排查后重新发布')
          return finish('failed', msg)
        }
      } else {
        tracker.end('datasync', 'skipped')
      }
      return finish(resultBox.rolledBack ? 'rolled_back' : 'success', resultBox.message)
    }
    if (isCanceled()) {
      log('warn', '发布已取消，服务器脚本将自动回滚')
      return finish('canceled', '用户取消')
    }
    if (tracker.state.datasync.status === 'waiting') tracker.end('datasync', 'skipped')
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

/** 按目标连接服务器（公共取配置+连接逻辑） */
async function connectTarget(projectId, targetId) {
  const list = projects.list()
  const project = list.find((p) => p.id === projectId)
  if (!project) throw new Error('项目配置不存在，请先保存')
  const target = getTarget(project, targetId)
  if (!target) throw new Error('项目缺少部署目标，请先在配置中添加')
  const creds = projects.getCredentials(projectId, target.id) || { password: '', passphrase: '' }
  const conn = await ssh.connect({
    host: target.server.host,
    port: target.server.port,
    username: target.server.username,
    authType: target.server.authType,
    password: creds.password,
    keyPath: target.server.keyPath,
    passphrase: creds.passphrase,
  })
  return { project, target, conn }
}

/** 测试连接：返回服务器环境信息（Docker/Compose/unzip/磁盘） */
async function testConnection(projectId, targetId) {
  const { target, conn } = await connectTarget(projectId, targetId)
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
async function listReleases(projectId, targetId) {
  const { target, conn } = await connectTarget(projectId, targetId)
  const home = target.remotePath
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

/** 校验数据库备份文件名（防路径注入：仅允许 db_ 前缀 + 安全字符） */
function assertDbBackupName(fileName) {
  if (typeof fileName !== 'string' || !/^db_[\w.-]+\.sql$/.test(fileName)) {
    throw new Error(`非法的备份文件名：${fileName}`)
  }
}

/** 数据库恢复所需配置（沿用发布前备份的 dbType/dbContainer/dbName/dbUser） */
function requireDbConfig(project) {
  const d = project.deploy || {}
  if (!d.backupDatabase) throw new Error('未启用「发布前备份数据库」，无法恢复（请先在部署设置中开启并配置数据库信息）')
  const container = String(d.dbContainer || '').trim()
  const name = String(d.dbName || '').trim()
  const user = String(d.dbUser || 'postgres').trim()
  if (!container || !name) throw new Error('数据库容器名或库名未配置')
  // 容器名/库名/用户名进入 shell 与 SQL 标识符位置，只放行安全字符
  for (const v of [container, name, user]) {
    if (!/^[\w.-]+$/.test(v)) throw new Error(`数据库配置含非法字符：${v}`)
  }
  if (d.dbType !== 'postgres') throw new Error('当前仅支持 PostgreSQL 备份恢复')
  return { container, name, user }
}

/** 列出服务器 backups/ 下的数据库备份（按时间倒序） */
async function listDbBackups(projectId, targetId) {
  const { project, target, conn } = await connectTarget(projectId, targetId)
  requireDbConfig(project) // 未配置数据库信息时列表也无意义
  const home = target.remotePath
  try {
    const res = await ssh.exec(conn,
      // glob 展开为全路径，awk 内取 basename；$5=大小 $6/$7=日期时间
      `ls -lht --time-style=+%Y-%m-%d\\ %H:%M ${quoteArg(ssh.remoteJoin(home, 'backups'))}/db_*.sql 2>/dev/null | awk '{n=split($8,a,"/"); print $5, $6, $7, a[n]}'`)
    const backups = (res.stdout || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
      const m = l.match(/^(\S+)\s+(\S+)\s+(\S+)\s+(db_[\w.-]+\.sql)$/)
      return m ? { size: m[1], time: `${m[2]} ${m[3]}`, fileName: m[4] } : null
    }).filter(Boolean)
    return { backups }
  } finally {
    ssh.close(conn)
  }
}

/**
 * 恢复数据库备份（高危操作，编排全程写部署日志并记入发布历史）：
 *   保底备份当前库 → 杀连接并重建空库 → 灌入备份 SQL（出错即停）→ 重启同 compose 项目容器。
 * 保底备份失败则中止——绝不覆盖「唯一可能完好的当前数据」。
 */
async function restoreDbBackup(projectId, targetId, fileName) {
  if (activeRun) throw new Error('已有发布任务进行中，请等待完成或取消')
  assertDbBackupName(fileName)
  const { project, target, conn } = await connectTarget(projectId, targetId)
  const db = requireDbConfig(project)
  const home = target.remotePath
  const backupDir = ssh.remoteJoin(home, 'backups')
  const stamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14)

  const runId = crypto.randomBytes(6).toString('hex')
  const logBuf = []
  logSink = (level, text) => logBuf.push(`${ts()} [${level.toUpperCase()}] ${text}`)
  const record = {
    id: runId, projectId: project.id, projectName: project.name, type: 'db-restore',
    targetId: target.id, targetName: target.name,
    version: fileName, oldVersion: '', status: 'running',
    startedAt: Date.now(), finishedAt: 0, durationMs: 0,
    host: `${target.server.host}:${target.server.port}`, remotePath: home,
    message: '', logFile: '',
  }
  activeRun = { id: runId, conn, canceled: false }
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

  try {
    const sqlFile = ssh.remoteJoin(backupDir, fileName)
    const has = await ssh.exec(conn, `test -f ${quoteArg(sqlFile)} && echo Y || echo N`)
    if (!/Y/.test(has.stdout || '')) throw new Error(`备份文件不存在：${fileName}`)

    log('info', `开始恢复数据库：${fileName}（库 ${db.name}@${db.container}）`)
    // 1. 保底备份当前库（失败即中止）
    const guardFile = ssh.remoteJoin(backupDir, `db_guard_${stamp}.sql`)
    log('info', '恢复前先保底备份当前数据库……')
    const guard = await ssh.exec(conn, `docker exec ${quoteArg(db.container)} pg_dump -U ${quoteArg(db.user)} ${quoteArg(db.name)} > ${quoteArg(guardFile)} && echo __GUARD_OK__`)
    if (guard.code !== 0 || !/__GUARD_OK__/.test(guard.stdout || '')) {
      throw new Error('保底备份失败，已中止恢复（当前数据未做任何改动）')
    }
    log('success', `保底备份完成：db_guard_${stamp}.sql`)

    // 2. 杀连接 + 重建空库 + 灌入（单条命令链，任一步失败整体失败）
    log('info', '重建数据库并灌入备份……')
    const restoreCmd = [
      `docker exec ${quoteArg(db.container)} psql -U ${quoteArg(db.user)} -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${db.name}' AND pid <> pg_backend_pid();"`,
      `docker exec ${quoteArg(db.container)} psql -U ${quoteArg(db.user)} -d postgres -c "DROP DATABASE ${db.name} WITH (FORCE);"`,
      `docker exec ${quoteArg(db.container)} psql -U ${quoteArg(db.user)} -d postgres -c "CREATE DATABASE ${db.name} OWNER ${db.user};"`,
      `docker exec -i ${quoteArg(db.container)} psql -U ${quoteArg(db.user)} -d ${quoteArg(db.name)} -v ON_ERROR_STOP=1 < ${quoteArg(sqlFile)}`,
      `echo __DB_RESTORE_OK__`,
    ].join(' && ')
    const res = await ssh.exec(conn, restoreCmd, (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        const t = line.replace(/\s+$/, '')
        if (t && !/^(__DB_RESTORE_OK__|DROP DATABASE|CREATE DATABASE|pg_terminate_backend)/.test(t)) log('info', `[恢复] ${t}`)
      }
    })
    if (res.code !== 0 || !/__DB_RESTORE_OK__/.test(res.stdout || '')) {
      throw new Error(`数据库恢复失败（退出码 ${res.code}），可用保底备份 db_guard_${stamp}.sql 再次恢复`)
    }
    log('success', '备份已灌入')

    // 3. 重启同 compose 项目的容器（应用连接池指向已重建的库）
    log('info', '重启应用容器……')
    await ssh.exec(conn,
      `PROJ=$(docker inspect ${quoteArg(db.container)} --format '{{index .Config.Labels "com.docker.compose.project"}}') && [ -n "$PROJ" ] && docker restart $(docker ps --filter label=com.docker.compose.project=$PROJ -q) || echo __NO_COMPOSE__`)
    log('success', `数据库恢复完成：${fileName}`)
    return finish('success', `数据库已恢复到备份 ${fileName}`)
  } catch (err) {
    const msg = (err && err.message) || String(err)
    log('error', `数据库恢复异常: ${msg}`)
    return finish('failed', msg)
  } finally {
    ssh.close(conn)
    logSink = null
    activeRun = null
  }
}

/** 手动回滚到指定版本（方案 §20：直接使用服务器已有 release，不重新上传） */
async function rollback(projectId, version, targetId) {
  if (activeRun) throw new Error('已有发布任务进行中')
  const { project, target, conn } = await connectTarget(projectId, targetId)
  const home = target.remotePath
  const h = target.health || {}
  const logBuf = []
  const runId = crypto.randomBytes(6).toString('hex')
  const record = {
    id: runId, projectId: project.id, projectName: project.name, type: 'rollback',
    targetId: target.id, targetName: target.name,
    version, oldVersion: '', status: 'running',
    startedAt: Date.now(), finishedAt: 0, durationMs: 0,
    host: `${target.server.host}:${target.server.port}`, remotePath: home,
    message: '', logFile: '',
  }
  logSink = (level, text) => logBuf.push(`${ts()} [${level.toUpperCase()}] ${text}`)
  log('info', `开始回滚 ${project.name}（${target.name}）→ ${version}`)
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
  listDbBackups, restoreDbBackup, assertDbBackupName,
  setEmitter, STAGES, resolveVersion, buildDeployArgs,
  getDataSync, validateDataSync, buildDataSyncCommand,
  getDataImport, renderImportCommand,
}
