/**
 * 一键填报（禅道工时）主进程模块自测（无框架，node scripts/fill-report-selftest.cjs 直接运行）
 * 覆盖：工时计算（锚点累进/扣午休/0.5h 取整/零段合并，与 wenxu/KnowMore 语义对齐）、
 *       禅道客户端请求构造（登录加密/cookie/重定向/JSON 容错解析/会话失效重登，fake fetch）、
 *       项目绑定持久化、提交汇总（left 扣减）、git 提交收集（真实 git 仓库集成）
 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

let passed = 0
let failed = 0
function test(name, fn) {
  return Promise.resolve()
    .then(() => fn())
    .then(() => {
      passed++
      console.log(`  ✓ ${name}`)
    })
    .catch((e) => {
      failed++
      console.error(`  ✗ ${name}\n    ${e.message}`)
    })
}

// ── electron 打桩（供 store.js / fill-service.js 在纯 Node 下运行） ──
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fillreport-test-'))
const stubExports = {
  app: { getPath: () => path.join(tmpRoot, 'userdata') },
  safeStorage: { isEncryptionAvailable: () => false }, // 走明文兜底分支，仍可验证存储往返
}
const Module = require('module')
const electronPath = require.resolve('electron')
require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: stubExports }

const fill = require('../electron/fill-service')
const { ZentaoClient, parseJsonPrefix, md5 } = require('../electron/zentao-service')
const { HanprintClient } = require('../electron/hanprint-service')
const store = require('../electron/store')

function round2of(n) { return Math.round(n * 100) / 100 }

// ── fake fetch 工具：把 handler 的静态返回包装成最小 Response ──
function makeResp({ status = 200, body = '', setCookies = [], location = null }) {
  return {
    status,
    headers: {
      get: (k) => (String(k).toLowerCase() === 'location' ? location : null),
      getSetCookie: () => setCookies,
    },
    text: async () => body,
    json: async () => JSON.parse(body),
  }
}
function fakeFetch(handler) {
  const calls = []
  const impl = async (url, opts) => {
    calls.push({ url: String(url), opts })
    return makeResp(await handler(String(url), opts || {}))
  }
  return { impl, calls }
}

// ═══════════ 工时计算 ═══════════
async function main() {
console.log('工时计算（总工时 + 按提交数比例分配，与提交时刻无关）:')

await test('workMinutes 扣除午休重叠', () => {
  const lunchS = 12 * 60, lunchE = 13 * 60
  assert.strictEqual(fill.workMinutes(10 * 60, 14 * 60, lunchS, lunchE), 180) // 240−60(1h午休)
  assert.strictEqual(fill.workMinutes(10 * 60, 14 * 60, lunchS, lunchE + 30), 150) // 1.5h 午休
  assert.strictEqual(fill.workMinutes(9 * 60, 11 * 60, lunchS, lunchE), 120) // 不重叠
  assert.strictEqual(fill.workMinutes(14 * 60, 13 * 60, lunchS, lunchE), 0) // 倒序
})

await test('单项目：总工时 = 首条提交→终点 扣午休整体取整', () => {
  const list = fill.distributeByProject([
    { time: '09:46', msg: 'feat: A', projectId: 'p1', projectName: 'P1' },
    { time: '10:31', msg: 'fix: B', projectId: 'p1', projectName: 'P1' },
  ], { startTime: '09:46', endTime: '12:02' })
  assert.strictEqual(list.length, 1)
  assert.strictEqual(list[0].hours, 2) // 136−2(午休重叠) = 134min → 120 = 2h
  assert.strictEqual(list[0].commitCount, 2)
  assert.strictEqual(list[0].work, '1. A\n2. B')
})

await test('多项目：按提交条数比例分配总工时，总和守恒', () => {
  // 总工时 09:00→17:30 扣 1h 午休 = 7.5h；A 2 条、B 1 条 → A 5h、B 2.5h
  const list = fill.distributeByProject([
    { time: '09:00', msg: 'feat: A1', projectId: 'pA', projectName: 'ProjA' },
    { time: '11:00', msg: 'feat: B1', projectId: 'pB', projectName: 'ProjB' },
    { time: '15:00', msg: 'feat: A2', projectId: 'pA', projectName: 'ProjA' },
  ], { startTime: '09:00', endTime: '17:30' })
  assert.strictEqual(list.length, 2)
  const a = list.find((g) => g.projectId === 'pA')
  const b = list.find((g) => g.projectId === 'pB')
  assert.strictEqual(a.hours, 5)
  assert.strictEqual(b.hours, 2.5)
  assert.strictEqual(round2of(a.hours + b.hours), 7.5)
})

await test('取整余量补给提交最多的项目，Σ 恒等于总工时', () => {
  // 总工时 09:00→12:30 扣午休重叠 30min = 180min → 3h；5 条提交分 2:2:1 →
  // 1.2/1.2/0.6 → 取整 1/1/0.5，余 0.5 补给提交最多的（并列取其一）
  const list = fill.distributeByProject([
    { time: '09:00', msg: 'a', projectId: 'p1', projectName: 'P1' },
    { time: '09:30', msg: 'a', projectId: 'p1', projectName: 'P1' },
    { time: '10:00', msg: 'b', projectId: 'p2', projectName: 'P2' },
    { time: '10:30', msg: 'b', projectId: 'p2', projectName: 'P2' },
    { time: '11:00', msg: 'c', projectId: 'p3', projectName: 'P3' },
  ], { startTime: '09:00', endTime: '12:30' })
  assert.strictEqual(round2of(list.reduce((s, g) => s + g.hours, 0)), 3)
  const p3 = list.find((g) => g.projectId === 'p3')
  assert.strictEqual(p3.hours, 0.5) // 3×1/5 = 0.6 → 0.5h
  const big = list.filter((g) => g.projectId !== 'p3')
  assert.strictEqual(round2of(big[0].hours + big[1].hours), 2.5) // 1.5 + 1（余量补给并列最多者其一）
})

await test('工时不足 0.5h 时记 0', () => {
  const list = fill.distributeByProject([
    { time: '09:00', msg: 'a', projectId: 'p1', projectName: 'P1' },
  ], { startTime: '09:00', endTime: '09:20' }) // 20min → 0
  assert.strictEqual(list.length, 1)
  assert.strictEqual(list[0].hours, 0)
})

await test('用户场景复现：9:30 实际到岗 → 19:03 点击生成 = 8.5h（与提交时刻无关）', () => {
  const list = fill.distributeByProject([
    { time: '09:46', msg: 'feat: A', projectId: 'p1', projectName: 'P1' }, // 首条提交晚于到岗，不影响起点
    { time: '15:00', msg: 'fix: B', projectId: 'p1', projectName: 'P1' },
  ], { startTime: '09:30', endTime: '19:03' })
  // 09:30→19:03 = 573min − 60min 午休 = 513 → 510 = 8.5h
  assert.strictEqual(list[0].hours, 8.5)
})

await test('用户场景：09:30 起点 → 17:05 当前 = 6.5h', () => {
  const list = fill.distributeByProject([
    { time: '09:30', msg: 'feat: A', projectId: 'p1', projectName: 'P1' },
    { time: '15:00', msg: 'fix: B', projectId: 'p1', projectName: 'P1' },
  ], { startTime: '09:30', endTime: '17:05' })
  assert.strictEqual(list[0].hours, 6.5) // 455−60 = 395min → 390 = 6.5h
})

await test('resolveEndTime：填报今天一律返回点击生成报告的时刻（含已过下班的加班时段）', () => {
  assert.strictEqual(fill.resolveEndTime('2026-09-07', '17:30', new Date('2026-09-07T16:05:00')), '16:05')
  assert.strictEqual(fill.resolveEndTime('2026-09-07', '17:30', new Date('2026-09-07T18:42:00')), '18:42')
})

await test('resolveEndTime：补填历史日期返回下班时间', () => {
  assert.strictEqual(fill.resolveEndTime('2026-09-06', '17:30', new Date('2026-09-07T16:05:00')), '17:30')
})

// ═══════════ 按项目聚合（一个项目一条记录 + 简洁编号内容） ═══════════
console.log('按项目聚合:')
await test('stripPrefix 去掉 Conventional Commits 前缀', () => {
  assert.strictEqual(fill.stripPrefix('feat: 完成订单模块'), '完成订单模块')
  assert.strictEqual(fill.stripPrefix('fix(parser): 修复解析'), '修复解析')
  assert.strictEqual(fill.stripPrefix('chore：中文冒号'), '中文冒号')
  assert.strictEqual(fill.stripPrefix('无前缀提交'), '无前缀提交')
})

// ═══════════ JSON 容错解析 ═══════════
console.log('禅道 JSON 容错解析:')
await test('parseJsonPrefix 正常解析', () => {
  assert.deepStrictEqual(parseJsonPrefix('{"a":1}'), { a: 1 })
})
await test('parseJsonPrefix 尾部脏数据截断解析', () => {
  assert.deepStrictEqual(parseJsonPrefix('{"a":1}<script>debug</script>'), { a: 1 })
})

// ═══════════ 禅道客户端（fake fetch） ═══════════
console.log('禅道客户端请求构造:')

function makeClient(handler) {
  const ff = fakeFetch(handler)
  const client = new ZentaoClient({ baseUrl: 'http://zt.example', account: 'wgl', password: 'secret', fetchImpl: ff.impl })
  return { client, ff }
}

await test('登录：md5(md5(pwd)+rand) 加密 + keepLogin + 成功判定', async () => {
  const { client, ff } = makeClient((url, opts) => {
    if (url.includes('refreshRandom')) return { body: '"rand42"' }
    if (opts.method === 'POST' && url.includes('user&f=login')) {
      const form = new URLSearchParams(opts.body)
      assert.strictEqual(form.get('account'), 'wgl')
      assert.strictEqual(form.get('password'), md5(md5('secret') + 'rand42'))
      assert.strictEqual(form.get('keepLogin'), '1')
      assert.strictEqual(form.get('verifyRand'), 'rand42')
      return { body: '{"result":"success","locate":"/"}' }
    }
    return { body: '' }
  })
  assert.strictEqual(await client.login(), true)
})

await test('登录失败抛出错误', async () => {
  const { client } = makeClient((url, opts) => {
    if (opts.method === 'POST') return { body: '{"result":"fail","message":"密码错误"}' }
    return { body: url.includes('refreshRandom') ? 'r1' : '' }
  })
  await assert.rejects(() => client.login(), /登录失败/)
})

await test('cookie 吸收并在后续请求携带', async () => {
  const { client, ff } = makeClient((url, opts) => {
    if (url === 'http://zt.example/index.php') return { setCookies: ['zentaosid=abc123'] }
    if (url.includes('refreshRandom')) return { body: 'r9' }
    if (opts.method === 'POST' && url.includes('user&f=login')) return { body: '{"result":"success"}' }
    if (url.includes('m=my&f=work')) {
      assert.strictEqual(opts.headers.Cookie, 'zentaosid=abc123')
      return { body: '{"data":{"tasks":[]}}' }
    }
    return { body: '' }
  })
  await client.login()
  await client.myTasks()
})

await test('myTasks：data 为字符串 + tasks 为 dict 时归一化', async () => {
  const inner = JSON.stringify({ tasks: { '101': { id: '101', name: '任务A', status: 'doing', consumed: '3', left: '5.5' } } })
  const { client } = makeClient((url) => {
    if (url.includes('m=my&f=work')) return { body: `{"status":"200","data":${JSON.stringify(inner)}}<!--dirty-->` }
    return { body: '' }
  })
  const tasks = await client.myTasks()
  assert.strictEqual(tasks.length, 1)
  assert.deepStrictEqual(tasks[0], { id: 101, name: '任务A', status: 'doing', consumed: 3, left: 5.5 })
})

await test('myTasks 会话失效自动重登一次', async () => {
  let myHit = 0
  let logins = 0
  const { client } = makeClient((url, opts) => {
    if (url.includes('refreshRandom')) return { body: 'rx' }
    if (opts.method === 'POST' && url.includes('user&f=login')) { logins++; return { body: '{"result":"success"}' } }
    if (url.includes('m=my&f=work')) {
      myHit++
      if (myHit === 1) return { body: '登录已超时，请重新登录' }
      return { body: '{"data":{"tasks":[]}}' }
    }
    return { body: '' }
  })
  await client.login() // 显式登录 1 次
  await client.myTasks() // 失效 → 重登（第 2 次）→ 成功
  assert.strictEqual(logins, 2)
})

await test('recordEstimates dryRun：表单数组语法构造（无 effortId 时键为行号，追加）', async () => {
  const { client } = makeClient((url, opts) => {
    if (url.includes('refreshRandom')) return { body: 'r1' }
    if (opts.method === 'POST' && url.includes('user&f=login')) return { body: '{"result":"success"}' }
    return { body: '' }
  })
  await client.login()
  const r = await client.recordEfforts(66, [
    { date: '2026-09-07', work: '完成A', consumed: 0.5, left: 3 },
    { date: '2026-09-07', work: '完成B', consumed: 2, left: 3 },
  ], true)
  assert.strictEqual(r.dryRun, true)
  assert.ok(r.url.includes('taskID=66'))
  assert.strictEqual(r.form['dates[1]'], '2026-09-07')
  assert.strictEqual(r.form['work[2]'], '完成B')
  assert.strictEqual(r.form['consumed[1]'], 0.5)
  assert.strictEqual(r.form['left[2]'], 3)
  assert.strictEqual(r.form['id[1]'], 1)
})

await test('recordEstimates 带 effortId 时键用已有记录 ID（更新覆盖）', async () => {
  const { client } = makeClient((url, opts) => {
    if (url.includes('refreshRandom')) return { body: 'r1' }
    if (opts.method === 'POST' && url.includes('user&f=login')) return { body: '{"result":"success"}' }
    return { body: '' }
  })
  await client.login()
  const r = await client.recordEfforts(66, [
    { date: '2026-09-07', work: '更新内容', consumed: 3, left: 1, effortId: 502 },
  ], true)
  assert.strictEqual(r.form['dates[502]'], '2026-09-07')
  assert.strictEqual(r.form['id[502]'], 502)
  assert.strictEqual(r.form['consumed[502]'], 3)
  assert.ok(!r.form['dates[1]'])
})

await test('getTaskEfforts：容错解析（data 字符串 + efforts dict + 尾部脏数据）', async () => {
  const inner = JSON.stringify({ efforts: { '501': { id: '501', date: '2026-09-07 00:00:00', work: '旧内容', consumed: '2', left: '1' } } })
  const { client } = makeClient((url, opts) => {
    if (url.includes('refreshRandom')) return { body: 'r1' }
    if (opts.method === 'POST' && url.includes('user&f=login')) return { body: '{"result":"success"}' }
    if (url.includes('recordEstimate') && opts.method !== 'POST') {
      return { body: `{"status":"200","data":${JSON.stringify(inner)}}<!--dirty-->` }
    }
    return { body: '' }
  })
  await client.login()
  const list = await client.getTaskEfforts(66)
  assert.strictEqual(list.length, 1)
  assert.strictEqual(list[0].id, 501)
  assert.strictEqual(list[0].date, '2026-09-07')
  assert.strictEqual(list[0].consumed, 2)
})

await test('getTaskEfforts：结构不可识别时返回空数组', async () => {
  const { client } = makeClient((url, opts) => {
    if (url.includes('refreshRandom')) return { body: 'r1' }
    if (opts.method === 'POST') return { body: '{"result":"success"}' }
    if (url.includes('recordEstimate') && opts.method !== 'POST') return { body: '登录已超时' }
    return { body: '' }
  })
  await client.login()
  assert.deepStrictEqual(await client.getTaskEfforts(66), [])
})

await test('POST 重定向（302）按浏览器语义降级为 GET 且不再提交表单', async () => {
  const posts = []
  const { client, ff } = makeClient((url, opts) => {
    if (opts.method === 'POST') {
      posts.push(url)
      return { status: 302, location: 'http://zt.example/index.php?m=my&f=index' }
    }
    return { body: '{"data":{}}' }
  })
  const resp = await client.request('/index.php?m=x&f=y', { method: 'POST', form: { a: 1 } })
  assert.strictEqual(resp.status, 200)
  assert.strictEqual(posts.length, 1) // 表单只提交一次
})

// ═══════════ 绑定持久化 ═══════════
console.log('项目绑定持久化:')
await test('bind/unbind 往返且绑定信息完整', () => {
  fill.bindProject('proj-1', 66, '开发任务')
  let all = fill.listBindings()
  assert.strictEqual(all['proj-1'].taskId, 66)
  assert.strictEqual(all['proj-1'].taskName, '开发任务')
  assert.ok(all['proj-1'].boundAt)
  fill.bindProject('proj-2', 77, '另一个任务')
  fill.unbindProject('proj-1')
  all = fill.listBindings()
  assert.ok(!all['proj-1'])
  assert.strictEqual(all['proj-2'].taskId, 77)
  fill.unbindProject('proj-2')
})
await test('suggestTask 名称互相包含', () => {
  const tasks = [{ id: 9, name: '电商决策支持系统开发' }, { id: 8, name: '企微机器人' }]
  assert.strictEqual(fill.suggestTask('电商决策支持系统', tasks), 9)
  assert.strictEqual(fill.suggestTask('XX企微机器人平台', tasks), 8)
  assert.strictEqual(fill.suggestTask('完全无关', tasks), null)
})

// ═══════════ 提交汇总 ═══════════
console.log('提交汇总（left 扣减）:')
await test('按任务聚合 + left = 原剩余 − 本次总消耗', () => {
  const planned = [
    { taskId: 66, hours: 0.5, work: '1. a' },
    { taskId: 66, hours: 2, work: '1. b' },
    { taskId: 88, hours: 1, work: '1. c' },
    { taskId: null, hours: 3, work: '1. 未绑定' },
  ]
  const ztTasks = [
    { id: 66, name: '任务A', left: 3.5 },
    { id: 88, name: '任务B', left: 0.5 },
  ]
  const tasks = fill.buildSubmitTasks(planned, ztTasks, '2026-09-07')
  assert.strictEqual(tasks.length, 2)
  const t66 = tasks.find((t) => t.taskId === 66)
  assert.strictEqual(t66.consumed, 2.5)
  assert.strictEqual(t66.left, 1)
  assert.strictEqual(t66.rows.length, 2)
  assert.ok(t66.rows.every((r) => r.left === 1))
  assert.strictEqual(t66.rows[0].date, '2026-09-07')
  const t88 = tasks.find((t) => t.taskId === 88)
  assert.strictEqual(t88.left, 0) // 0.5 - 1 → 最低为 0
})
await test('任务不在我的任务列表时 taskLeft=null 仍可构造', () => {
  const tasks = fill.buildSubmitTasks([{ taskId: 999, hours: 1, work: '1. x' }], [], '2026-09-07')
  assert.strictEqual(tasks[0].taskLeft, null)
  assert.strictEqual(tasks[0].left, 0)
})

// ═══════════ 汉印条目构造（百分比 Σ=100） ═══════════
console.log('汉印条目构造:')
const HP_GROUPS = [
  { type: 1, typeName: '日常事务', projectId: '900', projectName: '日常', tasks: [{ Key: '66', Name: '同名干扰任务' }] },
  { type: 3, typeName: '软件项目', projectId: '799', projectName: '电商决策支持系统', tasks: [
    { Key: '66', Name: '电商决策支持系统开发', GlProjectGuid: '', GlprojectName: '', BigKey: 'b1', BigName: '大项目', ProductKey: 'p1', ProductName: '产品A', StartTime: '2026-01-01', EndTime: '2026-12-31', StartTime2: '2026-01-02', EndTime2: null, IsOp: 1, PlmTotalHour: 100, ProductTime: null, DivisionName: '软件部' },
    { Key: '88', Name: '任务B', GlProjectGuid: '', GlprojectName: '', BigKey: '', BigName: '', ProductKey: '', ProductName: '', StartTime: null, EndTime: null, StartTime2: null, EndTime2: null, IsOp: 0, PlmTotalHour: 0, ProductTime: null, DivisionName: '' },
  ] },
]

await test('按禅道任务在 type=3 分组匹配并换算百分比', () => {
  const tasks = [
    { taskId: 66, consumed: 2.5 },
    { taskId: 88, consumed: 0.5 },
  ]
  const { items, unmatched } = fill.buildHpItems(tasks, HP_GROUPS, '2026-09-07')
  assert.deepStrictEqual(unmatched, [])
  assert.strictEqual(items.length, 2)
  assert.strictEqual(items[0].ProjectType, 3)
  assert.strictEqual(items[0].ProjectId, '799')
  assert.strictEqual(items[0].TaskId, '66')
  assert.strictEqual(items[0].BigProjectName, '大项目')
  assert.strictEqual(items[0].IsOp, true)
  assert.strictEqual(items[0].ActualStartTime, '2026-01-02')
  assert.strictEqual(items[0].WorkDate, '2026-09-07')
  assert.strictEqual(items[0].AddType, 0)
  // ΣPercent 必须为 100（汉印硬约束）
  const sum = items.reduce((s, x) => s + x.Percent, 0)
  assert.strictEqual(sum, 100)
})

await test('未匹配任务的占比份额并入余数补给第一条，Σ 仍=100', () => {
  const tasks = [
    { taskId: 66, consumed: 2 },
    { taskId: 999, consumed: 2 }, // 汉印无此任务
  ]
  const { items, unmatched } = fill.buildHpItems(tasks, HP_GROUPS, '2026-09-07')
  assert.deepStrictEqual(unmatched, [999])
  assert.strictEqual(items.length, 1)
  assert.strictEqual(items[0].Percent, 100) // 50 + 余数 50
})

await test('四舍五入误差由第一条吸收（Σ 恒等 100）', () => {
  const tasks = [
    { taskId: 66, consumed: 1 },
    { taskId: 88, consumed: 1 },
    { taskId: 77, consumed: 1 },
  ]
  const { items, unmatched } = fill.buildHpItems(tasks, [
    ...HP_GROUPS,
    { type: 3, typeName: '软件项目', projectId: '800', projectName: 'P2', tasks: [{ Key: '77', Name: '任务C' }] },
  ], '2026-09-07')
  assert.deepStrictEqual(unmatched, [])
  // 3 任务各 1/3 → 33/33/33=99，余数 1 补第一条
  const sum = items.reduce((s, x) => s + x.Percent, 0)
  assert.strictEqual(sum, 100)
})

await test('全部未匹配时返回空', () => {
  const { items, unmatched } = fill.buildHpItems([{ taskId: 999, consumed: 1 }], HP_GROUPS, '2026-09-07')
  assert.deepStrictEqual(items, [])
  assert.deepStrictEqual(unmatched, [999])
})

// ═══════════ 汉印客户端（fake fetch） ═══════════
console.log('汉印客户端请求构造:')
function makeHpClient(handler) {
  const ff = fakeFetch(handler)
  const client = new HanprintClient({ baseUrl: 'http://hp.example', clientId: '1', account: '21290', password: 'secret', fetchImpl: ff.impl })
  return { client, ff }
}
function jsonResp(obj, setCookies = []) {
  return { body: JSON.stringify(obj), setCookies }
}

await test('登录：getToken 参数与 token 保存', async () => {
  const { client, ff } = makeHpClient((url) => {
    if (url.includes('/login/getToken')) {
      assert.ok(url.includes('clientId=1') && url.includes('userName=21290') && url.includes('pwd=secret'))
      return jsonResp({ code: 0, data: 'tok-1' })
    }
    return jsonResp({ code: 0, data: null })
  })
  await client.login()
  assert.strictEqual(client.token, 'tok-1')
})

await test('登录失败抛出平台错误信息', async () => {
  const { client } = makeHpClient(() => jsonResp({ code: -1, data: null, msg: '用户不存在' }))
  await assert.rejects(() => client.login(), /用户不存在/)
})

await test('业务请求带 token 头 + code!=0 抛错', async () => {
  const { client } = makeHpClient((url, opts) => {
    if (url.includes('/com/workhour/GetDict')) {
      assert.strictEqual(opts.headers.token, 'tok-x')
      return jsonResp({ code: 0, data: [] })
    }
    if (url.includes('/com/workhour/GetProjectList')) {
      return jsonResp({ code: -1, data: null, msg: '无权限' })
    }
    return jsonResp({ code: 0, data: 't' })
  })
  client.token = 'tok-x'
  assert.deepStrictEqual(await client.getData('/com/workhour/GetDict', { dictType: 1 }), [])
  client.token = 'tok-bad'
  await assert.rejects(() => client.getData('/com/workhour/GetProjectList', { projecttype: 3 }), /汉印接口错误/)
})

await test('token 过期（code=-2）自动重登一次', async () => {
  let hits = 0
  let logins = 0
  const { client } = makeHpClient((url) => {
    if (url.includes('/login/getToken')) { logins += 1; return jsonResp({ code: 0, data: 'tok-new' }) }
    if (url.includes('/com/workhour/GetDict')) {
      hits += 1
      return hits === 1 ? jsonResp({ code: -2, data: null, msg: 'token 过期' }) : jsonResp({ code: 0, data: [] })
    }
    return jsonResp({ code: 0, data: 't' })
  })
  client.token = 'tok-old'
  assert.deepStrictEqual(await client.getData('/com/workhour/GetDict', { dictType: 1 }), [])
  assert.strictEqual(logins, 1)
  assert.strictEqual(client.token, 'tok-new')
})

await test('add：JSON 数组提交体 + token 头', async () => {
  const { client, ff } = makeHpClient((url, opts) => {
    if (url.includes('/com/workhour/add')) {
      assert.strictEqual(opts.headers.token, 'tok-add')
      assert.strictEqual(opts.headers['Content-Type'], 'application/json;charset=utf8')
      const arr = JSON.parse(opts.body)
      assert.ok(Array.isArray(arr) && arr.length === 1)
      assert.strictEqual(arr[0].Percent, 100)
      return jsonResp({ code: 0, data: null })
    }
    return jsonResp({ code: 0, data: 't' })
  })
  client.token = 'tok-add'
  const r = await client.add([{ Percent: 100, WorkDate: '2026-09-07' }])
  assert.strictEqual(r.status, 'ok')
})

await test('add dryRun 只回显不发', async () => {
  const { client, ff } = makeHpClient(() => { throw new Error('不应发请求') })
  client.token = 'tok'
  const r = await client.add([{ Percent: 100 }], true)
  assert.strictEqual(r.dryRun, true)
  assert.ok(r.url.includes('/com/workhour/add'))
  assert.strictEqual(ff.calls.length, 0)
})

await test('getByDate：携带 token 查询当日已填', async () => {
  const { client } = makeHpClient((url, opts) => {
    if (url.includes('/com/workhour/GetByDate')) {
      assert.strictEqual(opts.headers.token, 'tok-q')
      assert.ok(url.includes('workDate=2026-09-07'))
      return jsonResp({ code: 0, data: [
        { Id: 11, TaskId: '66', Percent: 60, ProjectType: 3 },
        { Id: 12, TaskId: '99', Percent: 0, ProjectType: -2 }, // 删除标记行（调用方负责跳过）
      ] })
    }
    return jsonResp({ code: 0, data: null })
  })
  client.token = 'tok-q'
  const rows = await client.getByDate('2026-09-07')
  assert.strictEqual(rows.length, 2) // 原样返回，跳过 ProjectType=-2 由调用方处理
  assert.strictEqual(rows[0].Id, 11)
})

// ═══════════ store 禅道配置（密码加密往返） ═══════════
console.log('禅道配置持久化:')
await test('保存密码 → 落盘为密文字段 → load 只下发脱敏标志', () => {
  const ok = store.save({ zentao: { baseUrl: 'http://10.11.34.2', account: 'wgl', password: 'p@ss' } })
  assert.strictEqual(ok, true)
  const disk = JSON.parse(fs.readFileSync(path.join(tmpRoot, 'userdata', 'config.json'), 'utf8'))
  assert.ok(disk.zentao.plain === 'p@ss' || disk.zentao.pwdEnc) // 明文兜底或加密字段
  assert.ok(!disk.zentao.password)
  const cfg = store.load()
  assert.strictEqual(cfg.zentao.pwdConfigured, true)
  assert.ok(cfg.zentao.pwdMasked.includes('p@ss'.slice(-4)) || cfg.zentao.pwdMasked)
  assert.ok(!cfg.zentao.pwdEnc)
  assert.strictEqual(store.getZentaoPwd(), 'p@ss')
})
await test('空密码保存保留旧密码，clearPwd 清除', () => {
  store.save({ zentao: { baseUrl: 'http://10.11.34.2', account: 'wgl' } })
  assert.strictEqual(store.getZentaoPwd(), 'p@ss')
  store.save({ zentao: { baseUrl: 'http://10.11.34.2', account: 'wgl', clearPwd: true } })
  assert.strictEqual(store.getZentaoPwd(), '')
})

// ═══════════ git 提交收集（真实 git 集成） ═══════════
console.log('git 提交收集（真实仓库）:')

function gitOk() {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true } catch { return false }
}

if (gitOk()) {
  const repoDir = path.join(tmpRoot, 'repo')
  fs.mkdirSync(repoDir, { recursive: true })
  function commitAt(date, time, msg, email = 'me@corp.com', name = 'Me') {
    execFileSync('git', ['commit', '--allow-empty', '-m', msg], {
      cwd: repoDir,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email,
        GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email,
        GIT_AUTHOR_DATE: `${date} ${time}:00 +0800`,
        GIT_COMMITTER_DATE: `${date} ${time}:00 +0800`,
      },
    })
  }
  // 动态历史日期（今天−3 天）：确保 resolveEndTime 返回下班时间而非「今天当前时刻」
  const pastDay = new Date(Date.now() - 3 * 86400000)
  const pd = (n) => String(n).padStart(2, '0')
  const pastDayStr = `${pastDay.getFullYear()}-${pd(pastDay.getMonth() + 1)}-${pd(pastDay.getDate())}`
  const dayBefore = new Date(pastDay.getTime() - 86400000)
  const dayBeforeStr = `${dayBefore.getFullYear()}-${pd(dayBefore.getMonth() + 1)}-${pd(dayBefore.getDate())}`
  execFileSync('git', ['init', '-q'], { cwd: repoDir })
  commitAt(pastDayStr, '09:12', 'feat: 完成订单模块')
  commitAt(pastDayStr, '11:40', 'fix: 修复库存同步')
  commitAt(pastDayStr, '14:05', 'refactor: 重构导出', 'other@corp.com', 'Other') // 他人提交，应被过滤
  commitAt(dayBeforeStr, '10:00', 'chore: 更早一天的提交') // 非当日，应被过滤

  await test('按日过滤 + 本人过滤 + 带HH:MM + 时间升序', async () => {
    const commits = await fill.collectTimedCommits(
      [{ id: 'p1', name: 'ProjA', repos: [repoDir] }],
      { date: pastDayStr, identities: [{ name: 'Me', email: 'me@corp.com' }] },
    )
    assert.strictEqual(commits.length, 2)
    assert.strictEqual(commits[0].time, '09:12')
    assert.strictEqual(commits[1].time, '11:40')
    assert.ok(commits[0].msg.includes('订单模块'))
    assert.strictEqual(commits[0].projectId, 'p1')
  })

  await test('identities 为空时返回空列表（工时绝不误算他人提交）', async () => {
    const commits = await fill.collectTimedCommits(
      [{ id: 'p1', name: 'ProjA', repos: [repoDir] }],
      { date: pastDayStr, identities: [] },
    )
    assert.strictEqual(commits.length, 0)
  })

  await test('plan 端到端：真实提交 → 按提交数分配 → 汇总（不依赖禅道）', async () => {
    // 不配置禅道：plan 应容错返回 ztError 而不抛异常；历史日期 → 终点为下班 17:30
    store.save({ roots: [], identities: [{ name: 'Me', email: 'me@corp.com' }] })
    const r = await fill.plan({
      date: pastDayStr,
      startTime: '09:12', // 实际上班时间（与首条提交时刻恰好相同，仅作对照）
      projects: [{ id: 'p1', name: 'ProjA', repos: [repoDir] }],
    })
    assert.ok(r.ztError)
    assert.strictEqual(r.planned.length, 1) // 一个项目一条记录
    // 总工时 09:12→17:30 = 498−60 = 438min → 420 = 7h（单项目全部分配）
    assert.strictEqual(r.planned[0].hours, 7)
    assert.strictEqual(r.rangeStart, '09:12')
    assert.strictEqual(r.rangeEnd, '17:30')
    assert.strictEqual(r.planned[0].work, '1. 完成订单模块\n2. 修复库存同步') // feat:/fix: 前缀已剥离
    assert.strictEqual(r.unmatchedProjects.length, 1) // 有提交但未绑定
  })

  await test('plan 起点与提交时刻无关：startTime 早于首条提交时多计时', async () => {
    store.save({ roots: [], identities: [{ name: 'Me', email: 'me@corp.com' }] })
    const r = await fill.plan({
      date: pastDayStr,
      startTime: '08:30', // 早于首条提交 09:12
      projects: [{ id: 'p1', name: 'ProjA', repos: [repoDir] }],
    })
    // 08:30→17:30 = 540−60 = 480 = 8h
    assert.strictEqual(r.planned[0].hours, 8)
    assert.strictEqual(r.rangeStart, '08:30')
  })
} else {
  console.log('  （git 不可用，跳过真实仓库集成用例）')
}

// ═══════════ 汇总 ═══════════
console.log(`\n结果: ${passed} 通过, ${failed} 失败`)
try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* 保留临时目录不影响结论 */ }
if (failed > 0) process.exitCode = 1
}

main().catch((e) => {
  console.error('自测脚本异常:', e)
  process.exitCode = 1
})
