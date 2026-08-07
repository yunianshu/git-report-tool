/**
 * 打包后钩子：手动注入应用图标与版本信息。
 *
 * 背景：electron-builder 内置的 rcedit 注入步骤在装有 360/腾讯电脑管家等
 * 实时防护的系统上，会因新 exe 被瞬间锁定而报 "Unable to commit changes"。
 * 本钩子在 win-unpacked 打包完成后、NSIS/便携版构建前运行，
 * 用带重试的手动 rcedit 注入，规避杀软锁定窗口。
 */
const { spawnSync } = require('child_process')
const path = require('path')
const fs = require('fs')

const RETRIES = 12
const RETRY_DELAY = 2000

function findRcedit() {
  const base = process.env.LOCALAPPDATA || ''
  try {
    const dir = path.join(base, 'electron-builder', 'Cache', 'winCodeSign')
    for (const d of fs.readdirSync(dir)) {
      const rce = path.join(dir, d, 'rcedit-x64.exe')
      if (fs.existsSync(rce)) return rce
    }
  } catch { /* noop */ }
  return null
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return

  const rcedit = findRcedit()
  const ico = path.join(context.packager.buildResourcesDir, 'icon.ico')
  const exe = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`)

  if (!rcedit || !fs.existsSync(ico) || !fs.existsSync(exe)) {
    console.warn('[afterPack-icon] 跳过：rcedit/icon/exe 缺失')
    return
  }

  const args = [
    exe,
    '--set-icon', ico,
    '--set-version-string', 'FileDescription', context.packager.appInfo.description || '',
    '--set-version-string', 'ProductName', context.packager.appInfo.productName,
    '--set-file-version', context.packager.appInfo.version,
    '--set-product-version', `${context.packager.appInfo.version}.0`,
  ]

  for (let i = 1; i <= RETRIES; i += 1) {
    const r = spawnSync(rcedit, args, { encoding: 'utf8' })
    if (r.status === 0) {
      console.log(`[afterPack-icon] 图标与版本信息已注入: ${exe}`)
      return
    }
    console.warn(`[afterPack-icon] rcedit 第 ${i}/${RETRIES} 次失败（疑似被实时防护锁定），${RETRY_DELAY / 1000}s 后重试`)
    await new Promise((res) => setTimeout(res, RETRY_DELAY))
  }
  throw new Error('[afterPack-icon] 图标注入失败：exe 多次被占用，请暂停杀软实时保护后重新打包')
}
