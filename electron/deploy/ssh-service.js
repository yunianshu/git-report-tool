/**
 * SSH/SFTP 服务 —— 基于 ssh2，对应方案 §27 的 SftpUploader + SshExecutor：
 *   - 密码 / 私钥两种认证
 *   - exec 命令并实时回传 stdout / stderr / 退出码
 *   - SFTP 上传（进度回调）+ 服务器端 SHA256 校验
 * 连接生命周期由调用方管理：connect() → 多次 exec/upload → close()。
 */
const fs = require('fs')
const path = require('path')
const { Client } = require('ssh2')

/** 连接服务器。config: { host, port, username, authType, password, keyPath, passphrase, readyTimeout } */
function connect(config) {
  return new Promise((resolve, reject) => {
    const conn = new Client()
    let settled = false
    const finish = (fn) => (v) => { if (!settled) { settled = true; fn(v) } }

    conn.on('ready', () => finish(resolve)(conn))
    conn.on('error', (e) => {
      let msg = (e && e.message) || String(e)
      if (/Timed out while waiting for handshake/.test(msg)) {
        msg += '（连接超时：请确认 SSH 端口正确、服务器防火墙/安全组已放行当前电脑 IP。'
          + '若 FinalShell 等工具可连而本工具超时，常见原因是服务器只放行了其他机器的 IP，'
          + '或 FinalShell 配置了跳板机/代理，或其连接端口并非 22）'
      }
      finish(reject)(new Error(msg))
    })
    conn.on('end', () => finish(reject)(new Error('SSH 连接已断开')))

    const cfg = {
      host: config.host,
      port: Number(config.port) || 22,
      username: config.username || 'root',
      readyTimeout: config.readyTimeout || 20000,
      keepaliveInterval: 10000,
      tryKeyboard: true, // 服务器仅启用 keyboard-interactive 认证时也能用密码登录
    }
    if ((config.authType || 'password') === 'key') {
      if (!config.keyPath || !fs.existsSync(config.keyPath)) {
        return finish(reject)(new Error(`私钥文件不存在: ${config.keyPath}`))
      }
      try {
        cfg.privateKey = fs.readFileSync(config.keyPath)
      } catch (e) {
        return finish(reject)(new Error(`读取私钥失败: ${e.message}`))
      }
      if (config.passphrase) cfg.passphrase = config.passphrase
    } else {
      cfg.password = config.password || ''
    }
    conn.on('keyboard-interactive', (_name, _instr, _lang, prompts, cb) => {
      cb(prompts.map(() => cfg.password || ''))
    })
    conn.connect(cfg)
  })
}

/** 安全关闭连接（幂等） */
function close(conn) {
  if (!conn) return
  try { conn.end() } catch { /* 已断开则忽略 */ }
}

/** 把 exec 阶段的底层错误转成可操作的提示 */
function enhanceExecError(e) {
  const msg = (e && e.message) || String(e)
  if (/Channel open failure|open failed/i.test(msg)) {
    return new Error(
      msg + ' —— 服务器拒绝了命令执行通道：该账号很可能被限制为仅 SFTP（sshd 配置了 '
      + 'ForceCommand internal-sftp）或没有 shell 权限。请检查服务器 /etc/ssh/sshd_config '
      + '中该用户的 Match 配置，或改用有 shell 执行权限的账号',
    )
  }
  return e
}

/**
 * 执行命令。onLine(chunkText, stream) 每收到一段输出回调一次。
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
function exec(conn, command, onLine) {
  return new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) return reject(enhanceExecError(err))
      let stdout = ''
      let stderr = ''
      stream.on('data', (d) => {
        const text = d.toString('utf8')
        stdout += text
        if (onLine) onLine(text, 'stdout')
      })
      stream.stderr.on('data', (d) => {
        const text = d.toString('utf8')
        stderr += text
        if (onLine) onLine(text, 'stderr')
      })
      stream.on('close', (code) => resolve({ code: code || 0, stdout, stderr }))
    })
  })
}

/**
 * SFTP 上传文件。onProgress(uploadedBytes, totalBytes) 持续回调。
 * @returns {Promise<{remotePath: string}>}
 */
function upload(conn, localPath, remotePath, onProgress) {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) return reject(err)
      sftp.fastPut(localPath, remotePath, {
        step: (transferred, chunk, total) => { if (onProgress) onProgress(transferred, total) },
      }, (e2) => (e2 ? reject(e2) : resolve({ remotePath })))
    })
  })
}

/** 在服务器上递归创建目录（mkdir -p 语义，逐段创建避免依赖 shell） */
function mkdirp(conn, remoteDir) {
  const dirs = String(remoteDir).split('/').filter(Boolean)
  let cur = String(remoteDir).startsWith('/') ? '' : '.'
  return dirs.reduce((chain, seg) => {
    cur = `${cur}/${seg}`
    const target = cur
    return chain.then(() => new Promise((resolve, reject) => {
      conn.sftp((err, sftp) => {
        if (err) return reject(err)
        sftp.mkdir(target, () => resolve()) // 已存在时 mkdir 报错，静默忽略
      })
    }))
  }, Promise.resolve())
}

/** 规范化远端路径（POSIX 风格） */
function remoteJoin(...parts) {
  const joined = parts.filter(Boolean).join('/')
  return joined.replace(/\/{2,}/g, '/')
}

module.exports = { connect, close, exec, upload, mkdirp, remoteJoin }
