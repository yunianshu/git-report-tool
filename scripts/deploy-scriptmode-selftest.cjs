/**
 * 脚本部署形态编排全链路自测（无框架，node scripts/deploy-scriptmode-selftest.cjs 直接运行）
 *
 * 验证策略（同 deploy-datasync-selftest.cjs 的边界划分）：
 *   - deploy-service.run()/rollback()/listReleases() 走真实业务编排（产物解析/SHA256/上传/阶段跟踪/历史落盘）
 *   - deploy.sh 不打桩：exec 桩收到 `bash .../deploy.sh ...` 时，把远端路径改写到本地「服务器根」后
 *     经 child_process 真实执行，输出流式回放给 onLine（阶段标记解析不失真）
 *   - 仅模拟无法在本机接入的外部系统：SSH/SFTP 传输（upload 落盘到「服务器目录」）
 *   - fake 项目发布包（tar.gz + upgrade.sh/start.sh/stop.sh）模拟 Vantage 形态契约
 * 覆盖：首次发布成功 / 升级停旧切指针 / 同版本重复发布快速失败（客户端+deploy.sh 双层守卫）/
 *   升级脚本失败尽力恢复 / 手动回滚 / 版本列表 / 本地产物保留
 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { spawnSync } = require('child_process')

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptmode-test-'))

// ── electron 打桩 ──
const electronPath = require.resolve('electron')
require.cache[electronPath] = {
  id: electronPath, filename: electronPath, loaded: true,
  exports: { app: { getPath: () => path.join(tmpRoot, 'userdata') }, safeStorage: { isEncryptionAvailable: () => false } },
}

// ── 「服务器」：本地目录模拟远端安装根；REMOTE_HOME 是 deploy.sh 收到的逻辑路径 ──
const SERVER_ROOT = path.join(tmpRoot, 'server-home')
const REMOTE_HOME = '/srv/vantage'
const serverState = { uploads: path.join(SERVER_ROOT, 'uploads'), execLog: [] }
fs.mkdirSync(serverState.uploads, { recursive: true })

/** Windows 路径 → Git Bash 可用路径（D:\x → /d/x） */
function msysPath(p) {
  const w = path.resolve(p).replace(/\\/g, '/')
  return w.replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`)
}

/** 远端命令改写为对本地「服务器根」可执行的命令 */
function localizeCmd(command) {
  const root = msysPath(SERVER_ROOT)
  return command.split(REMOTE_HOME).join(root)
}

// ── ssh-service 打桩 ──
const realSsh = require('../electron/deploy/ssh-service')
require.cache[require.resolve('../electron/deploy/ssh-service')] = {
  id: require.resolve('../electron/deploy/ssh-service'),
  filename: require.resolve('../electron/deploy/ssh-service'),
  loaded: true,
  exports: {
    remoteJoin: realSsh.remoteJoin,
    connect: async () => ({
      stub: true,
      sftp: (cb) => cb(null, {
        // uploadTextFile 直写 deploy.sh：落到「服务器」deployer/（exec 时真实执行的就是它）
        createWriteStream: (remotePath) => {
          const rel = path.relative(REMOTE_HOME, remotePath).replaceAll('\\', '/')
          const dest = path.join(SERVER_ROOT, rel)
          fs.mkdirSync(path.dirname(dest), { recursive: true })
          const s = fs.createWriteStream(dest)
          const origEnd = s.end.bind(s)
          s.end = (...a) => { setTimeout(() => s.emit('close'), 30); return origEnd(...a) }
          return s
        },
        end: () => {},
      }),
    }),
    close: () => {},
    mkdirp: async (_c, dir) => {
      const rel = path.relative(REMOTE_HOME, dir)
      if (rel && !rel.startsWith('..')) fs.mkdirSync(path.join(SERVER_ROOT, rel), { recursive: true })
    },
    upload: async (_conn, localPath, remotePath, onProgress) => {
      const rel = path.relative(REMOTE_HOME, remotePath).replaceAll('\\', '/')
      const dest = path.join(SERVER_ROOT, rel)
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.copyFileSync(localPath, dest)
      const size = fs.statSync(dest).size
      if (onProgress) onProgress(size, size)
      return { remotePath }
    },
    exec: async (_conn, command, onLine) => {
      serverState.execLog.push(command)
      const shaM = command.match(/sha256sum '([^']+)'/)
      if (shaM) {
        const rel = path.relative(REMOTE_HOME, shaM[1]).replaceAll('\\', '/')
        const local = path.join(SERVER_ROOT, rel)
        assert.ok(fs.existsSync(local), `上传的包应真实存在于服务器目录: ${shaM[1]}`)
        const hash = crypto.createHash('sha256').update(fs.readFileSync(local)).digest('hex')
        return { code: 0, stdout: `${hash}\n`, stderr: '' }
      }
      // cat <home>/CURRENT（run 的旧版本查询）：真实读「服务器」指针文件
      const catM = command.match(/^cat '([^']*CURRENT)' /)
      if (catM) {
        const local = path.join(SERVER_ROOT, 'CURRENT')
        return { code: 0, stdout: fs.existsSync(local) ? fs.readFileSync(local, 'utf8') : '', stderr: '' }
      }
      // deploy.sh / releases 列表 / CURRENT 指针读取 → 对本地服务器根真实执行
      const m = command.match(/bash '([^']*deploy\.sh)'/)
      if (m || /ls -1 .*releases/.test(command)) {
        const local = localizeCmd(command)
        const bashExe = process.env.SHELL ? undefined : 'bash'
        const r = spawnSync(bashExe || 'bash', ['-c', local], { encoding: 'utf8' })
        const out = `${r.stdout || ''}${r.stderr || ''}`
        // 流式回放：deploy-service 的阶段标记解析依赖 onLine 回调
        if (onLine) for (const line of out.split(/\r?\n/)) if (line) onLine(line, 'stdout')
        return { code: r.status ?? 1, stdout: out, stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    },
  },
}

const deployProjects = require('../electron/deploy/deploy-projects')
const deployService = require('../electron/deploy/deploy-service')

// ── fake 项目（Vantage 形态）：VERSION + release/ 产物目录 ──
function makeFakeArtifact(projectDir, name, behaviour) {
  const stage = path.join(projectDir, '.staging', name)
  fs.mkdirSync(stage, { recursive: true })
  fs.writeFileSync(path.join(stage, 'VERSION'), `${name.split('-v')[1].split('-')[0]}\n`)
  fs.writeFileSync(path.join(stage, 'upgrade.sh'), [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'SD="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"; IR="$INSTALL_ROOT"',
    'echo "[fake-upgrade] $(cat "$IR/CURRENT" 2>/dev/null || echo none) -> $(basename -- "$SD")"',
    'echo "[env] java=$(command -v java 2>/dev/null || echo none) pgdump=${PG_DUMP:-none}"',
    `if [ "${behaviour}" = "fail" ]; then echo "[fake-upgrade] 模拟升级失败"; exit 7; fi`,
    'mkdir -p "$IR/backups"; touch "$IR/backups/backup-$(date +%s%N).tar.gz"',
    'if [ -f "$IR/CURRENT" ]; then old="$(cat "$IR/CURRENT")"; [ -f "$IR/releases/$old/stop.sh" ] && INSTALL_ROOT="$IR" bash "$IR/releases/$old/stop.sh" || true; fi',
    'printf \'%s\\n\' "$(basename -- "$SD")" > "$IR/CURRENT"',
    'INSTALL_ROOT="$IR" bash "$SD/start.sh"',
  ].join('\n'))
  fs.writeFileSync(path.join(stage, 'start.sh'), [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'SD="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"; IR="${INSTALL_ROOT:-$(dirname -- "$SD")}"',
    'echo $$ > "$SD/app.pid"; touch "$SD/.started"',
  ].join('\n'))
  fs.writeFileSync(path.join(stage, 'stop.sh'), [
    '#!/usr/bin/env bash',
    'SD="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"',
    'rm -f "$SD/.started"',
  ].join('\n'))
  const rel = path.join(projectDir, 'release')
  fs.mkdirSync(rel, { recursive: true })
  const out = path.join(rel, `${name}.tar.gz`)
  const r = spawnSync('bash', ['-c', `cd "$(dirname '${msysPath(stage)}')" && tar -czf '${msysPath(out)}' '${name}' && rm -rf '${msysPath(stage)}'`], { encoding: 'utf8' })
  assert.strictEqual(r.status, 0, `打 fake 包失败: ${r.stderr}`)
  return out
}

function seedScriptProject(dir) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'VERSION'), '1.0.0\n')
  const saved = deployProjects.save(deployProjects.normalizeProject({
    name: '脚本部署项目', localPath: dir, deployMode: 'script',
    scriptMode: { artifactDir: 'release', upgradeScript: 'upgrade.sh' },
    version: { strategy: 'auto', manual: '' },
    targets: [{
      id: 't1', name: '生产', remotePath: REMOTE_HOME,
      server: { host: '203.0.113.10', port: 22, username: 'root', authType: 'password' },
      health: { enabled: false, url: '', timeout: 90, interval: 3 },
    }],
  }))
  return saved.id
}

function runDeploy(projectId) {
  const events = { stages: [], logs: [], done: null }
  deployService.setEmitter((ch, payload) => {
    if (ch === 'deploy:stage') events.stages.push(payload)
    if (ch === 'deploy:log') events.logs.push(payload)
    if (ch === 'deploy:done') events.done = payload.record
  })
  return deployService.run(projectId, 't1').then((record) => ({ record, events }))
}

async function main() {
  let passed = 0
  try {
    const projDir = path.join(tmpRoot, 'proj')
    const projectId = seedScriptProject(projDir)

    // ── 1. 产物缺失：检查阶段失败，不产生任何服务器操作 ──
    serverState.execLog.length = 0
    const { record: recNoPkg } = await runDeploy(projectId)
    assert.strictEqual(recNoPkg.status, 'failed')
    assert.ok(/产物目录/.test(recNoPkg.message), `消息应提示产物缺失: ${recNoPkg.message}`)
    assert.strictEqual(recNoPkg.stages.check.status, 'failed')
    assert.strictEqual(serverState.execLog.length, 0, '产物缺失不得连接服务器')
    passed += 1
    console.log('  ✓ 产物目录为空 → 检查阶段失败且零服务器操作')

    // ── 2. 版本不匹配：拒绝发布过期产物 ──
    makeFakeArtifact(projDir, 'app-v0.9.0-001', 'success')
    const { record: recStale } = await runDeploy(projectId)
    assert.strictEqual(recStale.status, 'failed')
    assert.ok(recStale.message.includes('1.0.0'), `消息应含期望版本: ${recStale.message}`)
    assert.ok(recStale.message.includes('app-v0.9.0-001.tar.gz'), '消息应提示最新产物名')
    passed += 1
    console.log('  ✓ 产物版本不匹配 → 拒发并提示最新产物')

    // ── 3. 首次发布成功：CURRENT 切新、服务器终态与历史正确 ──
    const pkg1 = makeFakeArtifact(projDir, 'app-v1.0.0-001', 'success')
    const { record: rec1, events: ev1 } = await runDeploy(projectId)
    assert.strictEqual(rec1.status, 'success', `首次发布应成功: ${rec1.message}\n${ev1.logs.map((l) => l.text).join('\n')}`)
    assert.strictEqual(rec1.version, '1.0.0', '版本应来自 VERSION 文件')
    assert.strictEqual(rec1.oldVersion, '', '首次发布无旧版本')
    assert.strictEqual(fs.readFileSync(path.join(SERVER_ROOT, 'CURRENT'), 'utf8').trim(), 'app-v1.0.0-001')
    assert.ok(fs.existsSync(path.join(SERVER_ROOT, 'releases', 'app-v1.0.0-001', '.started')), '新版本 start.sh 应已执行')
    assert.ok(!fs.existsSync(path.join(SERVER_ROOT, 'uploads', 'app-v1.0.0-001.tar.gz')), '成功后上传包应清理')
    const hist = fs.readFileSync(path.join(SERVER_ROOT, 'deploy-history.jsonl'), 'utf8')
    assert.ok(hist.includes('"status":"success"'), '服务器端历史应记录 success')
    assert.strictEqual(rec1.stages.build.status, 'skipped', '脚本模式 build 应为 skipped')
    assert.strictEqual(rec1.stages.backup.status, 'skipped', '脚本模式 backup 由项目脚本负责，应 skipped')
    assert.strictEqual(rec1.stages.start.status, 'success')
    assert.ok(fs.existsSync(pkg1), '本地产物包必须保留（keepLocal）')
    passed += 1
    console.log('  ✓ 首次发布成功：真实 deploy.sh 执行、CURRENT/start/清理/历史终态正确')

    // ── 4. 升级发布：oldVersion 正确、停旧切新 ──
    makeFakeArtifact(projDir, 'app-v1.0.0-002', 'success')
    const { record: rec2 } = await runDeploy(projectId)
    assert.strictEqual(rec2.status, 'success', `升级发布应成功: ${rec2.message}`)
    assert.strictEqual(rec2.oldVersion, 'app-v1.0.0-001', 'oldVersion 应取自 CURRENT 指针')
    assert.strictEqual(fs.readFileSync(path.join(SERVER_ROOT, 'CURRENT'), 'utf8').trim(), 'app-v1.0.0-002')
    assert.ok(!fs.existsSync(path.join(SERVER_ROOT, 'releases', 'app-v1.0.0-001', '.started')), '旧版本应被 stop')
    assert.ok(fs.existsSync(path.join(SERVER_ROOT, 'releases', 'app-v1.0.0-002', '.started')))
    passed += 1
    console.log('  ✓ 升级发布：CURRENT 指针切换、旧版本停止、oldVersion 识别正确')

    // ── 5. 同版本重复发布：上传前快速失败，运行中的 release 目录零改动 ──
    fs.writeFileSync(path.join(SERVER_ROOT, 'releases', 'app-v1.0.0-002', '.sentinel'), 'keep')
    serverState.execLog.length = 0
    const { record: recDup, events: evDup } = await runDeploy(projectId)
    assert.strictEqual(recDup.status, 'failed')
    assert.ok(/线上已运行同一版本/.test(recDup.message), `消息应说明同版本拒绝: ${recDup.message}`)
    assert.strictEqual(recDup.stages.check.status, 'success')
    assert.strictEqual(recDup.stages.upload.status, 'failed', '应在上传阶段前拦截')
    assert.ok(!serverState.execLog.some((c) => /deploy\.sh.*deploy/.test(c)), '不得执行服务器部署脚本')
    assert.ok(!fs.existsSync(path.join(SERVER_ROOT, 'uploads', 'app-v1.0.0-002.tar.gz')), '发布包不得上传')
    assert.ok(fs.existsSync(path.join(SERVER_ROOT, 'releases', 'app-v1.0.0-002', '.sentinel')), '运行中版本目录必须原样保留')
    assert.strictEqual(fs.readFileSync(path.join(SERVER_ROOT, 'CURRENT'), 'utf8').trim(), 'app-v1.0.0-002')
    passed += 1
    console.log(`  ✓ 同版本重复发布：上传前快速失败（日志 ${evDup.logs.length} 行）、运行中 release 目录零改动`)

    // ── 6. 升级脚本失败：整单 failed、尽力恢复当前版本 ──
    makeFakeArtifact(projDir, 'app-v1.0.0-003', 'fail')
    const { record: rec3, events: ev3 } = await runDeploy(projectId)
    assert.strictEqual(rec3.status, 'failed')
    assert.ok(rec3.message.includes('升级脚本执行失败'), `消息应含升级脚本失败: ${rec3.message}`)
    assert.strictEqual(fs.readFileSync(path.join(SERVER_ROOT, 'CURRENT'), 'utf8').trim(), 'app-v1.0.0-002', 'CURRENT 不得切换到失败版本')
    assert.ok(fs.existsSync(path.join(SERVER_ROOT, 'releases', 'app-v1.0.0-002', '.started')), '当前版本应被幂等拉起')
    assert.ok(ev3.logs.some((l) => l.text.includes('尽力恢复')), '日志应体现尽力恢复路径')
    passed += 1
    console.log('  ✓ 升级脚本失败 → 整单 failed、尽力恢复当前版本、CURRENT 不变')

    // ── 7. listReleases（script 形态：CURRENT 指针解析） ──
    const lr = await deployService.listReleases(projectId, 't1')
    assert.ok(lr.releases.includes('app-v1.0.0-001') && lr.releases.includes('app-v1.0.0-002'))
    assert.strictEqual(lr.current, 'app-v1.0.0-002')
    passed += 1
    console.log('  ✓ listReleases：releases 列表与 CURRENT 指向解析正确')

    // ── 8. 手动回滚：CURRENT 切目标并启动，stop 当前 ──
    const rb = await deployService.rollback(projectId, 'app-v1.0.0-001', 't1')
    assert.strictEqual(rb.status, 'success', `回滚应成功: ${rb.message}`)
    assert.strictEqual(fs.readFileSync(path.join(SERVER_ROOT, 'CURRENT'), 'utf8').trim(), 'app-v1.0.0-001')
    assert.ok(fs.existsSync(path.join(SERVER_ROOT, 'releases', 'app-v1.0.0-001', '.started')), '目标版本应启动')
    assert.ok(!fs.existsSync(path.join(SERVER_ROOT, 'releases', 'app-v1.0.0-002', '.started')), '原版本应停止')
    passed += 1
    console.log('  ✓ 手动回滚：真实 rollback 子命令执行、启停与指针终态正确')

    // ── 9. 环境引导：toolbox 的 JDK/pg_dump 优先并导出给项目升级脚本 ──
    const tbJdk = path.join(SERVER_ROOT, 'shared', 'toolbox', 'jdk', 'bin')
    const tbBin = path.join(SERVER_ROOT, 'shared', 'toolbox', 'bin')
    fs.mkdirSync(tbJdk, { recursive: true })
    fs.mkdirSync(tbBin, { recursive: true })
    fs.writeFileSync(path.join(tbJdk, 'java'), '#!/usr/bin/env bash\necho "openjdk version \\"17.9.9\\" 2026-01-01" >&2\n')
    fs.writeFileSync(path.join(tbBin, 'pg_dump'), '#!/usr/bin/env bash\necho toolbox-pgdump-wrapper\n')
    fs.chmodSync(path.join(tbJdk, 'java'), 0o755)
    fs.chmodSync(path.join(tbBin, 'pg_dump'), 0o755)
    makeFakeArtifact(projDir, 'app-v1.0.0-010', 'success')
    const { record: recBoot, events: evBoot } = await runDeploy(projectId)
    assert.strictEqual(recBoot.status, 'success', `引导场景发布应成功: ${recBoot.message}\n${evBoot.logs.map((l) => l.text).join('\n')}`)
    assert.ok(evBoot.logs.some((l) => l.text.includes('使用工具箱 JDK')), '日志应提示使用工具箱 JDK')
    const envLine = evBoot.logs.find((l) => l.text.includes('[env] java='))
    assert.ok(envLine, '项目升级脚本应输出环境信息')
    assert.ok(envLine.text.includes('shared/toolbox/jdk/bin/java'), 'PATH 应导出 toolbox JDK')
    assert.ok(envLine.text.includes('shared/toolbox/bin/pg_dump'), 'PG_DUMP 应导出 toolbox 包装')
    passed += 1
    console.log('  ✓ 环境引导：toolbox JDK/pg_dump 优先并正确导出给项目脚本')

    // ── 10. deploy.sh 服务端同版本守卫：解压后、删除运行中目录前直接失败 ──
    // 绕过客户端编排直接调 deploy.sh（模拟旧版客户端/手工调用），兜底保护运行中版本
    const srv2 = path.join(tmpRoot, 'server2')
    const rel2 = path.join(srv2, 'releases', 'app-v1.0.0-002')
    fs.mkdirSync(rel2, { recursive: true })
    fs.writeFileSync(path.join(rel2, '.sentinel'), 'keep')
    fs.writeFileSync(path.join(srv2, 'CURRENT'), 'app-v1.0.0-002\n')
    fs.mkdirSync(path.join(srv2, 'uploads'), { recursive: true })
    fs.copyFileSync(
      path.join(projDir, 'release', 'app-v1.0.0-002.tar.gz'),
      path.join(srv2, 'uploads', 'app-v1.0.0-002.tar.gz'))
    const shPath = path.join(tmpRoot, 'deploy-guard.sh')
    fs.writeFileSync(shPath,
      fs.readFileSync(path.join(__dirname, '..', 'electron', 'deploy', 'scripts', 'deploy.sh'), 'utf8').replace(/\r\n/g, '\n'))
    const rGuard = spawnSync('bash', [msysPath(shPath), 'deploy', '--mode', 'script',
      '--app', '守卫测试', '--home', msysPath(srv2), '--package', 'app-v1.0.0-002.tar.gz',
      '--version', '1.0.0', '--upgrade-script', 'upgrade.sh',
      '--no-bootstrap-java', '--no-bootstrap-pgdump',
      '--no-backup-code', '--no-backup-db', '--auto-rollback', '--no-health',
      '--keep-releases', '10', '--keep-backups', '10', '--keep-upload'], { encoding: 'utf8' })
    const guardOut = `${rGuard.stdout || ''}${rGuard.stderr || ''}`
    assert.notStrictEqual(rGuard.status, 0, '同版本发布应非零退出')
    assert.ok(guardOut.includes('线上已运行同一版本'), `deploy.sh 应输出同版本守卫信息: ${guardOut}`)
    assert.ok(!guardOut.includes('已解压'), '守卫应在解压完成标记前失败')
    assert.ok(fs.existsSync(path.join(rel2, '.sentinel')), '运行中版本目录必须原样保留')
    assert.strictEqual(fs.readFileSync(path.join(srv2, 'CURRENT'), 'utf8').trim(), 'app-v1.0.0-002')
    passed += 1
    console.log('  ✓ deploy.sh 同版本守卫：改动任何服务器状态前直接失败、运行目录零改动')

    console.log(`\n脚本部署形态编排自测通过（${passed} 组断言）`)
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error('自测失败：', err)
  process.exitCode = 1
})
