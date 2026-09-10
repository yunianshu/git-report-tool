/**
 * 发布包符号链接自测：symlink 目录/文件必须进包（否则服务器端缺文件），环路不爆栈不重复收录
 * 用法：node scripts/deploy-packager-symlink-selftest.cjs
 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { buildPackage } = require('../electron/deploy/packager')
const { execFileSync } = require('child_process')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-sym-'))
fs.mkdirSync(path.join(root, 'real'), { recursive: true })
fs.writeFileSync(path.join(root, 'real', 'inner.txt'), 'inner')
fs.writeFileSync(path.join(root, 'top.txt'), 'top')
// symlink 目录（Git Bash: MSYS=winsymlinks:nativestrict 需要；junction 兜底）
try {
  fs.symlinkSync(path.join(root, 'real'), path.join(root, 'linkdir'), 'junction')
} catch { fs.symlinkSync(path.join(root, 'real'), path.join(root, 'linkdir'), 'dir') }
// symlink 文件
try { fs.symlinkSync(path.join(root, 'top.txt'), path.join(root, 'link.txt'), 'file') } catch {}
// 环路：linkdir 内再链回根（junction 形式模拟）
try { fs.symlinkSync(root, path.join(root, 'real', 'loop'), 'junction') } catch {}

;(async () => {
  const pack = await buildPackage({ projectDir: root, appName: 'symtest', version: '1.0.0' })
  // 解压验证内容
  const out = path.join(root, '..', 'unzipped')
  fs.mkdirSync(out, { recursive: true })
  execFileSync(path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'tar.exe'), ['-xf', pack.zipPath, '-C', out])
  const names = []
  const walk = (d, p) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const rp = p ? p + '/' + e.name : e.name; if (e.isDirectory()) walk(path.join(d, e.name), rp); else names.push(rp) } }
  walk(out, '')
  console.log('包内文件:', names.join(', '))
  assert.ok(names.includes('top.txt'), '普通文件应在包内')
  assert.ok(names.some((n) => n.startsWith('linkdir/') && n.endsWith('inner.txt')), 'symlink 目录内容应在包内')
  assert.ok(names.includes('link.txt'), 'symlink 文件应在包内')
  assert.ok(!names.some((n) => n.includes('loop')), '环路不应爆栈/重复收录')
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(out, { recursive: true, force: true })
  console.log('symlink 打包验证：全部通过')
})().catch((e) => { console.error(e.message); process.exit(1) })
