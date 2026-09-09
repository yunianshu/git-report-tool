/**
 * 本地快速更新：vite + electron-builder --dir（跳过 NSIS/便携版/签名）+ install-local 同步安装。
 * win-unpacked 的主 exe 偶发被杀软实时扫描锁住导致 open UNKNOWN——失败后自动清理重试（最多 3 次）。
 * 用法：npm run update:local
 */
const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const pkg = require(path.join(ROOT, 'package.json'))
const unpacked = path.join(ROOT, 'release', pkg.version, 'win-unpacked')

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/** 关闭正在运行的本应用（安装目录与 release 目录两个来源） */
function killApp() {
  const ps = `Get-Process | Where-Object { $_.Path -like '*${pkg.name}*' -or $_.Path -like '*${ROOT.replace(/\\/g, '\\\\')}\\\\release*' } | Stop-Process -Force -ErrorAction SilentlyContinue`
  spawnSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'ignore' })
  sleep(800)
}

function cleanUnpacked() {
  fs.rmSync(unpacked, { recursive: true, force: true })
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: true, cwd: ROOT })
  return r.status === 0
}

killApp()
const MAX = 3
let ok = false
for (let i = 1; i <= MAX; i++) {
  cleanUnpacked()
  console.log(`[update-local] 第 ${i}/${MAX} 次构建…`)
  if (run('npx', ['electron-builder', '--dir', '--publish=never'])) { ok = true; break }
  console.warn(`[update-local] 构建失败（疑似产物被占用），清理后重试`)
  sleep(1500)
}
if (!ok) {
  console.error('[update-local] 连续 3 次构建失败，请手动检查 release 目录占用')
  process.exit(1)
}
process.exit(run('node', [path.join(__dirname, 'install-local.cjs')]) ? 0 : 1)
