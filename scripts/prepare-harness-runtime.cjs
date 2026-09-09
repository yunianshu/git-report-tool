/**
 * 准备内置 DeepSeek Harness 依赖树（构建期，幂等）
 *
 * 目标：让用户机器**不装 dsh、不装 Node** 也能使用 Harness。
 * 产物：
 *   build/harness-runtime/dsh/node_modules/@deepseek-ai/dsh/...  —— dsh 依赖树（中间产物，不打进安装包）
 *   build/harness-runtime.tar.gz                                 —— 依赖树单文件归档（**随包分发**）
 *   build/harness-runtime.json                                   —— 版本标记，运行时据此判断是否需要重新解包
 *
 * 为什么打成单个归档：依赖树约 2.6 万个文件（264MB），原样放进 NSIS 安装包时
 * 安装器要逐文件解压到临时目录再整树复制，Windows 实测约 16 分钟（同样内容直接
 * 复制约 1 分钟），用户会以为安装卡死。单文件只需数秒，首次启动再由
 * electron/harness-runtime.js 解包到用户数据目录。
 *
 * 运行时用的是 Electron 自带的 Node（`ELECTRON_RUN_AS_NODE=1` + `--expose-internals`），
 * 因此这里不再下载独立 Node 运行时——Electron 40+ 内置 Node 24，
 * 具备 dsh 需要的 `node:sqlite` 与 `import.meta.main`。
 *
 * 幂等：已存在且版本标记一致时直接跳过；可用 DSH_RUNTIME_FORCE=1 强制重建。
 * 版本可用环境变量覆盖：DSH_VERSION。
 * 用法：node scripts/prepare-harness-runtime.cjs [--platform win32 --arch x64]
 */
const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const BUILD_DIR = path.join(ROOT, 'build')
const OUT_DIR = path.join(BUILD_DIR, 'harness-runtime')
const ARCHIVE = path.join(BUILD_DIR, 'harness-runtime.tar.gz')
const SHIPPED_MARKER = path.join(BUILD_DIR, 'harness-runtime.json')
/** dsh 需要 Node ≥22.5 的 node:sqlite 与 ≥22.18 的 import.meta.main（Electron 40+ 内置 Node 24） */
const DSH_VERSION = process.env.DSH_VERSION || '0.1.5-alpha.1'
/**
 * dsh-win32-process 补丁号。dsh 的 Windows Job 子进程路径用 CreateProcessW
 * 创建目标进程（pwsh 等）时不带 CREATE_NO_WINDOW，而内置运行时以
 * ELECTRON_RUN_AS_NODE 跑 dsh——进程链上没有任何控制台，Windows 只能为每个
 * 控制台程序新分配一个，默认终端（Windows Terminal）就会弹窗：Harness 会话
 * 每执行一次命令弹一个空白终端窗口。补丁给三处创建标志位补上
 * CREATE_NO_WINDOW(0x08000000)。补丁号变化会改变版本标记，触发客户端重新解包。
 */
const WIN32_NO_WINDOW_PATCH = 1
const MARKER = path.join(OUT_DIR, 'runtime.json')

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

const PLATFORM = arg('platform', process.platform)
const ARCH = arg('arch', process.arch)

function log(...args) {
  console.log('[harness-runtime]', ...args)
}

function dirSizeMB(dir) {
  let total = 0
  const walk = (p) => {
    for (const item of fs.readdirSync(p, { withFileTypes: true })) {
      const full = path.join(p, item.name)
      if (item.isDirectory()) walk(full)
      else if (item.isFile()) total += fs.statSync(full).size
    }
  }
  try { walk(dir) } catch { /* noop */ }
  return (total / 1048576).toFixed(0)
}

function installDsh() {
  const dshDir = path.join(OUT_DIR, 'dsh')
  const entry = path.join(dshDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (fs.existsSync(entry)) {
    log(`dsh 依赖树已存在：${entry}`)
    return entry
  }
  fs.mkdirSync(dshDir, { recursive: true })
  fs.writeFileSync(path.join(dshDir, 'package.json'), JSON.stringify({ name: 'harness-runtime', private: true }, null, 2))
  log(`安装 @deepseek-ai/dsh@${DSH_VERSION}（约 260MB，首次较慢）`)
  const npmArgs = ['install', '--prefix', dshDir, '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error', `@deepseek-ai/dsh@${DSH_VERSION}`]
  const command = PLATFORM === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'npm'
  const args = PLATFORM === 'win32' ? ['/d', '/s', '/c', `npm ${npmArgs.join(' ')}`] : npmArgs
  const result = spawnSync(command, args, { cwd: dshDir, stdio: 'inherit', windowsHide: true })
  if (result.status !== 0 || !fs.existsSync(entry)) {
    throw new Error(`安装 @deepseek-ai/dsh@${DSH_VERSION} 失败（exit=${result.status}）`)
  }
  log(`dsh 依赖树就绪：${entry}`)
  return entry
}

/** 把依赖树打成单文件归档（幂等：归档与标记都比依赖树新则跳过） */
async function packArchive(expected) {
  const upToDate = (() => {
    if (process.env.DSH_RUNTIME_FORCE) return false
    if (!fs.existsSync(ARCHIVE) || !fs.existsSync(SHIPPED_MARKER)) return false
    try {
      const shipped = JSON.parse(fs.readFileSync(SHIPPED_MARKER, 'utf8'))
      if (JSON.stringify(shipped) !== JSON.stringify(expected)) return false
      return fs.statSync(ARCHIVE).mtimeMs >= fs.statSync(MARKER).mtimeMs
    } catch { return false }
  })()
  if (upToDate) {
    log(`归档已是最新，跳过：${ARCHIVE}`)
    return
  }
  const tar = require('tar')
  log(`打包归档（约 ${dirSizeMB(OUT_DIR)} MB，gzip 压缩）…`)
  fs.rmSync(ARCHIVE, { force: true })
  await tar.c({ gzip: true, cwd: BUILD_DIR, file: ARCHIVE, portable: true }, ['harness-runtime'])
  fs.writeFileSync(SHIPPED_MARKER, JSON.stringify(expected, null, 2))
  log(`归档完成：${ARCHIVE}（${(fs.statSync(ARCHIVE).size / 1048576).toFixed(0)} MB）`)
}

/**
 * 给 dsh-win32-process 补 CREATE_NO_WINDOW（幂等；期望的字面量找不到时抛错，
 * 避免 dsh 升级后补丁静默失效、带着弹窗问题出包）。
 *
 * 三处创建点与对应替换（CREATE_NO_WINDOW = 0x08000000 = 134217728）：
 *   - 普通目标 CreateProcessW：   1028（SUSPENDED|UNICODE_ENV）→ 134218756
 *   - 受限令牌 Job：              4（SUSPENDED）→ 134217732
 *   - 受限令牌探测（管道版）：    0 → 134217728
 */
function patchWin32Console() {
  const file = path.join(OUT_DIR, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-win32-process', 'lib', 'index.js')
  const source = fs.readFileSync(file, 'utf8')
  if (source.includes('134218756')) {
    log(`dsh-win32-process 已带 CREATE_NO_WINDOW 补丁（v${WIN32_NO_WINDOW_PATCH}），跳过`)
    return
  }
  const replacements = [
    ['null, null, 1, 1028, environment', 'null, null, 1, 134218756, environment'],
    ['createRestrictedProcess(api, options, commandLine, 4, startupInfo, processInfo)',
      'createRestrictedProcess(api, options, commandLine, 134217732, startupInfo, processInfo)'],
    ['options.args), 0, startupInfo, processInfo) === 0', 'options.args), 134217728, startupInfo, processInfo) === 0'],
  ]
  let patched = source
  for (const [from, to] of replacements) {
    const count = patched.split(from).length - 1
    if (count !== 1) {
      throw new Error(`dsh-win32-process 补丁点期望出现 1 次实际 ${count} 次：「${from}」——dsh 版本可能已变化，请核对 @deepseek-ai/dsh@${DSH_VERSION} 的进程创建标志`)
    }
    patched = patched.replace(from, to)
  }
  fs.writeFileSync(file, patched)
  log(`已为 dsh-win32-process 补 CREATE_NO_WINDOW（v${WIN32_NO_WINDOW_PATCH}，3 处创建点）`)
}

async function main() {
  const expected = { dshVersion: DSH_VERSION, platform: PLATFORM, arch: ARCH, win32NoWindowPatch: WIN32_NO_WINDOW_PATCH }
  let needInstall = true
  if (!process.env.DSH_RUNTIME_FORCE && fs.existsSync(MARKER)) {
    try {
      const current = JSON.parse(fs.readFileSync(MARKER, 'utf8'))
      if (JSON.stringify(current) === JSON.stringify(expected)) {
        log('内置依赖树已是目标版本，跳过安装')
        needInstall = false
      }
    } catch { /* 标记损坏则重建 */ }
  }
  if (needInstall) {
    log(`准备内置依赖树：platform=${PLATFORM} arch=${ARCH} dsh=${DSH_VERSION}`)
    installDsh()
    fs.writeFileSync(MARKER, JSON.stringify(expected, null, 2))
    log(`依赖树完成：${OUT_DIR}（约 ${dirSizeMB(OUT_DIR)} MB）`)
  }
  patchWin32Console()
  await packArchive(expected)
}

/** electron-builder beforePack 钩子入口；直接执行时也走同一逻辑 */
module.exports = async function beforePack() {
  await main()
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[harness-runtime] 失败：', err.message)
    process.exit(1)
  })
}
