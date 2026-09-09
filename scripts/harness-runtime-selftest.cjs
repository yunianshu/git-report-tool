/**
 * 内置运行时解包自测（合成小归档，秒级）
 *
 * 覆盖：解包到短路径目录 / 幂等复用 / 版本变化重新解包 / DSH_RUNTIME_DIR 优先。
 * 用法：node scripts/harness-runtime-selftest.cjs
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const tar = require('tar')

let failed = 0
const check = (name, cond, detail) => {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${name}${detail ? `  ${detail}` : ''}`)
  if (!cond) failed++
}

/** 造一棵最小运行时树（与真实结构同形的入口路径） */
function writeTree(root) {
  const entry = path.join(root, 'harness-runtime', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  fs.mkdirSync(path.dirname(entry), { recursive: true })
  fs.writeFileSync(entry, '// dsh entry\n')
  return entry
}

;(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-harness-runtime-'))
  const resDir = path.join(root, 'resources')
  const cacheDir = path.join(root, 'cache')
  fs.mkdirSync(resDir, { recursive: true })

  writeTree(path.join(root, 'src'))
  const archive = path.join(resDir, 'harness-runtime.tar.gz')
  await tar.c({ gzip: true, cwd: path.join(root, 'src'), file: archive, portable: true }, ['harness-runtime'])

  const markerA = { dshVersion: '0.0.1-test', platform: 'win32', arch: 'x64' }
  const markerFile = path.join(resDir, 'harness-runtime.json')
  fs.writeFileSync(markerFile, JSON.stringify(markerA, null, 2))

  // 打包态模拟：resources 指向临时目录，缓存目录指定到临时目录，跳过开发态原样目录
  process.resourcesPath = resDir
  process.env.DSH_RUNTIME_CACHE = cacheDir
  delete process.env.DSH_RUNTIME_DIR

  const rt = require('../electron/harness-runtime')

  check('R0 识别随包归档', rt.hasShippedRuntime() === true, rt.shippedArchive())

  const dir1 = await rt.ensureBundledRuntime()
  check('R1 解包到用户数据目录下的短路径 runtime 目录', dir1 === cacheDir, dir1)
  check('R2 解包后入口文件存在',
    fs.existsSync(path.join(dir1, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')))
  check('R3 写入完成标记（供下次判断版本）', fs.existsSync(path.join(dir1, '.complete')))

  // 幂等：目录内放哨兵文件，重复调用不应重新解包（重新解包会清空目录）
  fs.writeFileSync(path.join(dir1, 'sentinel.txt'), 'keep')
  const dir2 = await rt.ensureBundledRuntime()
  check('R4 同版本复用已解包目录（不重复解包）',
    dir2 === dir1 && fs.existsSync(path.join(dir1, 'sentinel.txt')), dir2)

  // 版本变化：原地重新解包（旧目录内容被替换）
  fs.writeFileSync(markerFile, JSON.stringify({ ...markerA, dshVersion: '0.0.2-test' }, null, 2))
  const dir3 = await rt.ensureBundledRuntime()
  check('R5 版本变化后重新解包', dir3 === dir1 && !fs.existsSync(path.join(dir1, 'sentinel.txt')))
  check('R6 新版本标记已写入',
    JSON.parse(fs.readFileSync(path.join(dir1, '.complete'), 'utf8')).dshVersion === '0.0.2-test')

  // DSH_RUNTIME_DIR 显式指定优先于归档解包
  const override = path.join(root, 'override')
  fs.mkdirSync(path.join(override, 'dsh'), { recursive: true })
  process.env.DSH_RUNTIME_DIR = override
  check('R7 DSH_RUNTIME_DIR 优先', (await rt.ensureBundledRuntime()) === override)
  // 指向无效目录 → 视为无内置运行时
  process.env.DSH_RUNTIME_DIR = path.join(root, 'nope')
  check('R8 DSH_RUNTIME_DIR 无效时不回退解包', (await rt.ensureBundledRuntime()) === '')

  try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* noop */ }
  console.log(failed ? `\n结果：${failed} 项失败` : '\n结果：全部通过')
  process.exit(failed ? 1 : 0)
})()
