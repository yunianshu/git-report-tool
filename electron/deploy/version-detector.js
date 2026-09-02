/**
 * 版本号自动识别 —— 按方案 §5.2 的优先级从项目根目录读取版本号：
 *   VERSION → 项目类型标准版本文件 → 手动指定（由调用方决定）
 * 支持：VERSION / package.json / pom.xml / build.gradle(.kts) / pubspec.yaml / *.csproj
 * 纯 Node 实现，不依赖 Electron，可独立单测。
 */
const fs = require('fs')
const path = require('path')

const VERSION_RE = /^\d+(\.\d+){0,3}([-+][0-9A-Za-z.-]+)?$/

function readFirstLine(p) {
  const text = fs.readFileSync(p, 'utf8')
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim()
    if (t) return t
  }
  return ''
}

/** package.json：取顶层 version 字段（忽略 workspaces 子包） */
function fromPackageJson(dir) {
  const p = path.join(dir, 'package.json')
  if (!fs.existsSync(p)) return ''
  try {
    const v = JSON.parse(fs.readFileSync(p, 'utf8')).version
    return typeof v === 'string' ? v.trim() : ''
  } catch {
    return ''
  }
}

/** pom.xml：取 <project> 直属的 <version>（跳过 dependencies 内的版本） */
function fromPom(dir) {
  const p = path.join(dir, 'pom.xml')
  if (!fs.existsSync(p)) return ''
  try {
    const xml = fs.readFileSync(p, 'utf8')
    // 去掉 parent 块后取第一个 <version>，即项目自身版本
    const body = xml.replace(/<parent>[\s\S]*?<\/parent>/, '')
    const m = body.match(/<version>([^<]+)<\/version>/)
    return m ? m[1].trim() : ''
  } catch {
    return ''
  }
}

/** build.gradle(.kts)：version 'x.y.z' / version = "x.y.z" */
function fromGradle(dir) {
  for (const name of ['build.gradle', 'build.gradle.kts']) {
    const p = path.join(dir, name)
    if (!fs.existsSync(p)) continue
    try {
      const text = fs.readFileSync(p, 'utf8')
      const m = text.match(/^\s*version\s*=?\s*['"]([^'"]+)['"]/m)
      if (m) return m[1].trim()
    } catch { /* 继续尝试下一个 */ }
  }
  return ''
}

/** pubspec.yaml（Flutter）：version: 1.2.3(+build) */
function fromPubspec(dir) {
  const p = path.join(dir, 'pubspec.yaml')
  if (!fs.existsSync(p)) return ''
  try {
    const text = fs.readFileSync(p, 'utf8')
    const m = text.match(/^version:\s*(['"]?)([^'"\s]+)\1\s*$/m)
    return m ? m[2].trim() : ''
  } catch {
    return ''
  }
}

/** *.csproj（.NET）：<Version> 优先，其次 <VersionPrefix> / <AssemblyVersion> */
function fromCsproj(dir) {
  let candidates = []
  try {
    candidates = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.csproj'))
  } catch {
    return ''
  }
  for (const name of candidates) {
    try {
      const xml = fs.readFileSync(path.join(dir, name), 'utf8')
      for (const tag of ['Version', 'VersionPrefix', 'AssemblyVersion']) {
        const m = xml.match(new RegExp(`<${tag}>\\s*([^<\\s]+)\\s*</${tag}>`, 'i'))
        if (m) return m[1].trim()
      }
    } catch { /* 尝试下一个 csproj */ }
  }
  return ''
}

/**
 * 检测项目版本号。
 * @returns {{ version: string, source: string }} source 标明来源，便于界面展示
 */
function detectVersion(projectDir) {
  const dir = projectDir
  if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    return { version: '', source: '' }
  }

  const versionFile = path.join(dir, 'VERSION')
  if (fs.existsSync(versionFile)) {
    const v = readFirstLine(versionFile)
    if (v && VERSION_RE.test(v)) return { version: v, source: 'VERSION' }
  }

  const attempts = [
    { v: fromPackageJson(dir), s: 'package.json' },
    { v: fromPom(dir), s: 'pom.xml' },
    { v: fromGradle(dir), s: 'build.gradle' },
    { v: fromPubspec(dir), s: 'pubspec.yaml' },
    { v: fromCsproj(dir), s: '*.csproj' },
  ]
  for (const a of attempts) {
    if (a.v && VERSION_RE.test(a.v)) return { version: a.v, source: a.s }
  }
  return { version: '', source: '' }
}

module.exports = { detectVersion }
