/**
 * 准备内置 DeepSeek Harness 依赖树（构建期，幂等）
 *
 * 目标：让用户机器**不装 dsh、不装 Node** 也能使用 Harness。
 * 产物（build/harness-runtime/，随 electron-builder extraResources 打包）：
 *   dsh/node_modules/@deepseek-ai/dsh/...    —— 固定版本的 dsh 依赖树
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
const OUT_DIR = path.join(ROOT, 'build', 'harness-runtime')
/** dsh 需要 Node ≥22.5 的 node:sqlite 与 ≥22.18 的 import.meta.main（Electron 40+ 内置 Node 24） */
const DSH_VERSION = process.env.DSH_VERSION || '0.1.5-alpha.1'
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

function main() {
  const expected = { dshVersion: DSH_VERSION, platform: PLATFORM, arch: ARCH }
  if (!process.env.DSH_RUNTIME_FORCE && fs.existsSync(MARKER)) {
    try {
      const current = JSON.parse(fs.readFileSync(MARKER, 'utf8'))
      if (JSON.stringify(current) === JSON.stringify(expected)) {
        log('内置依赖树已是目标版本，跳过')
        return
      }
    } catch { /* 标记损坏则重建 */ }
  }
  log(`准备内置依赖树：platform=${PLATFORM} arch=${ARCH} dsh=${DSH_VERSION}`)
  installDsh()
  fs.writeFileSync(MARKER, JSON.stringify(expected, null, 2))
  const size = (dir) => {
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
  log(`完成：${OUT_DIR}（约 ${size(OUT_DIR)} MB）`)
}

/** electron-builder beforePack 钩子入口；直接执行时也走同一逻辑 */
module.exports = async function beforePack() {
  main()
}

if (require.main === module) {
  try {
    main()
  } catch (err) {
    console.error('[harness-runtime] 失败：', err.message)
    process.exit(1)
  }
}
