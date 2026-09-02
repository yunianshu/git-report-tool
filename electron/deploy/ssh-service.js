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
    conn.on('error', finish(reject))
    conn.on('end', () => finish(reject)(new Error('SSH 连接已断开')))

    const cfg = {
      host: config.host,
      port: Number(config.port) || 22,
      username: config.username || 'root',
      readyTimeout: config.readyTimeout || 15000,
      keepaliveInterval: 10000,
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
    conn.connect(cfg)
  })
}

/** 安全关闭连接（幂等） */
function close(conn) {
  if (!conn) return
  try { conn.end() } catch { /* 已断开则忽略 */ }
}

/**
 * 执行命令。onLine(chunkText, stream) 每收到一段输出回调一次。
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
function exec(conn, command, onLine) {
  return new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) return reject(err)
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
