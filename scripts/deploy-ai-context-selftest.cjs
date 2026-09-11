/** 运行真实 Vue setup/watch 与异步操作；只替换 IPC 和确认框，不依赖浏览器或服务器。 */
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const Module = require('module')
const { parse, compileScript } = require('@vue/compiler-sfc')
const { transformSync } = require('esbuild')
const vue = require('vue')

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

async function main() {
  const filename = path.resolve(__dirname, '../src/components/deploy/DeployAiAssistant.vue')
  const { descriptor } = parse(fs.readFileSync(filename, 'utf8'))
  const compiled = compileScript(descriptor, { id: 'deploy-ai-context-test' })
  const mod = new Module(filename, module)
  mod.filename = filename
  mod.paths = Module._nodeModulePaths(path.dirname(filename))
  let confirmation = deferred()
  const errors = []
  mod.require = (id) => {
    if (id === 'element-plus') return {
      ElMessage: { error: (v) => errors.push(v), success() {}, warning() {} },
      ElMessageBox: { confirm: () => confirmation.promise },
    }
    if (id === '../../utils/ipc') {
      const helper = new Module(path.resolve(path.dirname(filename), '../../utils/ipc.js'), module)
      helper._compile(transformSync(fs.readFileSync(helper.id, 'utf8'), { format: 'cjs' }).code, helper.id)
      return helper.exports
    }
    return Module.prototype.require.call(mod, id)
  }
  mod._compile(transformSync(compiled.content, { format: 'cjs' }).code, filename)
  const props = vue.reactive({ modelValue: true, form: { id: 'A', localPath: '/project/A' }, activeTargetId: 'test' })
  const emits = []
  const calls = []
  let diagnostic = deferred()
  let generation = deferred()
  global.window = { gitReport: {
    deployAiDiagnose: (...args) => { calls.push(['diagnose', ...args]); return diagnostic.promise },
    deployAiGenerateFile: (...args) => { calls.push(['generate', ...args]); return generation.promise },
    deployAiApply: async (...args) => { calls.push(['apply', ...args]); return { ok: true } },
    deployAiWriteFiles: async (...args) => { calls.push(['write', ...args]); return { ok: true, results: [] } },
  } }
  // 使用自定义 Vue renderer 创建真实组件实例，包含销毁生命周期。
  let state
  const component = { setup() {
    state = mod.exports.default.setup(props, { expose() {}, emit: (...args) => emits.push(args) })
    return () => null
  } }
  const renderer = vue.createRenderer({
    createComment: () => ({}), insert() {}, remove() {}, parentNode() {}, nextSibling() {},
  })
  const app = renderer.createApp(component)
  app.mount({})
  const response = { ok: true, plan: { deployMode: 'docker', files: [] } }
  try {
    const oldDiagnostic = diagnostic
    const oldRun = state.run()
    props.form.id = 'B'
    diagnostic = deferred()
    const newRun = state.run()
    // 两轮使用独立 Promise，旧回包不能改变新轮次状态。
    oldDiagnostic.resolve(response)
    await oldRun
    assert.strictEqual(state.result.value, null)
    assert.strictEqual(state.running.value, true, '旧请求结束不得停止新请求的加载状态')
    diagnostic.resolve(response)
    await newRun
    assert.strictEqual(state.result.value.plan.deployMode, 'docker')
    assert.deepStrictEqual(calls.filter((c) => c[0] === 'diagnose').map((c) => c[1]), ['A', 'B'])

    props.activeTargetId = 'production'
    assert.strictEqual(state.result.value, null, '切换环境必须清空方案')
    diagnostic = deferred()
    const lateRun = state.run()
    props.form.id = 'C'
    diagnostic.resolve(response)
    await lateRun
    assert.strictEqual(state.result.value, null, '旧诊断回包不得进入新项目')

    state.result.value = response
    const pendingApply = state.apply()
    props.activeTargetId = 'test'
    confirmation.resolve()
    await pendingApply
    assert.ok(!calls.some((c) => c[0] === 'apply'), '确认框打开后切环境不得套用')

    confirmation = deferred()
    state.selectedFiles.value = [{ path: 'start.sh', content: 'echo test' }]
    const pendingWrite = state.writeSelected()
    props.form.id = 'D'
    confirmation.resolve()
    await pendingWrite
    assert.ok(!calls.some((c) => c[0] === 'write'), '确认框打开后切项目不得写文件')

    const row = { path: 'start.sh', content: '' }
    const pendingGenerate = state.generateOne(row)
    props.modelValue = false
    generation.resolve({ ok: true, content: 'echo stale' })
    await pendingGenerate
    assert.strictEqual(row.content, '', '关闭后迟到的文件内容必须丢弃')
    assert.strictEqual(state.previewVisible.value, false)

    props.modelValue = true
    state.result.value = response
    confirmation = deferred()
    const validApply = state.apply()
    confirmation.resolve()
    await validApply
    assert.deepStrictEqual(calls.find((c) => c[0] === 'apply').slice(1, 3), ['D', 'test'], '正常套用应绑定当前项目和环境')
    assert.ok(emits.some((e) => e[0] === 'applied'))
    assert.deepStrictEqual(errors, [])
  } finally {
    app.unmount()
    delete global.window
  }
  console.log('全部通过：AI 部署助手上下文隔离（切换 / 迟到响应 / 确认框 / 正常套用）')
}
main().catch((e) => { console.error(e); process.exitCode = 1 })
