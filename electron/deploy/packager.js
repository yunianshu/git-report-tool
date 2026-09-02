/**
 * 发布包生成 —— 按方案 §6/§7 生成 ZIP：
 *   - 默认排除常见构建/缓存目录与临时文件
 *   - 支持项目自定义 .deployignore 规则（与 .gitignore 语法子集）
 *   - ZIP 内文件平铺在根目录（服务器端 unzip -d 后即为项目根）
 *   - 同时计算 SHA256，上传后用于服务器端完整性校验
 * 纯 Node 实现（archiver），可独立单测。
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const archiver = require('archiver')

/** 方案 §6.1 默认排除规则 */
const DEFAULT_EXCLUDES = [
  '.git', '.idea', '.vscode', 'node_modules', 'target', 'build', 'dist',
  '.gradle', 'logs', 'tmp', 'temp', '*.log', '*.tmp',
]

/**
 * 将一条忽略规则编译为匹配器。支持语法子集：
 *   - 注释行（#）与空行忽略
 *   - 「名称」：匹配任意层级的同名文件/目录（如 node_modules、.git）
 *   - 「*.后缀」：匹配任意层级的通配文件（如 *.log）
 *   - 「dir/」：匹配任意层级的目录（排除其下所有内容）
 *   - 「a/b」或「/a/b」：相对项目根的路径匹配
 */
function compileRule(raw) {
  let line = raw.trim()
  if (!line || line.startsWith('#')) return null
  if (line.startsWith('!')) return null // v1 不支持反向规则，忽略
  // gitignore 语义：前导 / 表示锚定项目根，必须先判断再去掉
  const anchored = line.startsWith('/')
  line = line.replace(/^\/+/, '').replace(/\/+$/, '')
  if (!line) return null
  const regexStr = line
    .split('/')
    .map((seg) => seg
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '[^/]'))
    .join('/')
  if (anchored || line.includes('/')) {
    // 锚定根或带路径：只从根匹配（注意不能误伤路径中段的同名目录）
    return { re: new RegExp(`^${regexStr}(/.*)?$`, 'i') }
  }
  // 纯名称/通配：匹配任意层级的段
  return { re: new RegExp(`(^|/)${regexStr}(/.*)?$`, 'i') }
}

/** 忽略规则集合 */
function createMatcher(extraRules) {
  const rules = [...DEFAULT_EXCLUDES, ...(extraRules || [])]
    .map(compileRule)
    .filter(Boolean)
  return {
    /** relPath 使用 POSIX 分隔符；返回 true 表示忽略 */
    ignored(relPath) {
      return rules.some((r) => r.re.test(relPath))
    },
  }
}

/** 递归收集未被忽略的文件（POSIX 相对路径） */
function collectFiles(rootDir, matcher, onFile) {
  const walk = (dir, rel) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of entries) {
      const relPath = rel ? `${rel}/${ent.name}` : ent.name
      if (matcher.ignored(relPath)) continue
      const abs = path.join(dir, ent.name)
      if (ent.isDirectory()) walk(abs, relPath)
      else if (ent.isFile()) onFile(abs, relPath)
    }
  }
  walk(rootDir, '')
}

/** 读取项目 .deployignore（存在时追加到默认规则） */
function readDeployIgnore(projectDir) {
  const p = path.join(projectDir, '.deployignore')
  if (!fs.existsSync(p)) return []
  try {
    return fs.readFileSync(p, 'utf8').split(/\r?\n/)
  } catch {
    return []
  }
}

/**
 * 生成发布包。
 * @param {object} opts { projectDir, appName, version, onProgress?(percent, fileCount) }
 * @returns {Promise<{zipPath, fileName, sha256, fileCount, sizeBytes}>}
 */
function buildPackage(opts) {
  const { projectDir, appName, version, onProgress } = opts || {}
  if (!fs.existsSync(projectDir)) return Promise.reject(new Error(`项目目录不存在: ${projectDir}`))

  const matcher = createMatcher(readDeployIgnore(projectDir))
  const stamp = formatStamp(new Date())
  const safeName = (appName || 'app').replace(/[^\w.-]+/g, '_')
  const fileName = `${safeName}-${version || 'unknown'}-${stamp}.zip`
  const zipPath = path.join(projectDir, fileName)

  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath)
    const archive = archiver('zip', { zlib: { level: 6 } })
    let fileCount = 0
    let settled = false
    const done = (fn) => (v) => { if (!settled) { settled = true; fn(v) } }

    output.on('close', done(() => {
      const sha256 = sha256File(zipPath)
      resolve({ zipPath, fileName, sha256, fileCount, sizeBytes: archive.pointer() })
    }))
    output.on('error', done(reject))
    archive.on('error', done(reject))
    archive.on('progress', (data) => {
      fileCount = data.entries.processed
      if (onProgress) onProgress(fileCount)
    })
    archive.pipe(output)

    const selfZipName = fileName // 输出 zip 就写在项目目录里，绝不能把自己打进去
    collectFiles(projectDir, matcher, (abs, rel) => {
      // .deployignore 是本工具的忽略规则文件；.dockerignore 必须保留（服务器端 docker build 依赖它过滤构建上下文）
      if (rel === selfZipName || rel === '.deployignore') return
      archive.file(abs, { name: rel })
    })
    archive.finalize()
  })
}

function formatStamp(d) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function sha256File(p) {
  // 项目源码包体积有限，直接同步读取计算，避免流式回调竞态
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
}

module.exports = { buildPackage, createMatcher, DEFAULT_EXCLUDES }
