/**
 * 内置 Harness 默认配置注入自测（纯文件系统，不启动 dsh）
 *
 * 验收标准（依据需求「随安装包分发 provider 与默认模型、不含密钥」）：
 * - 全新机器：写入汉印/智谱 provider 与默认模型，且文件中不出现任何密钥值
 * - 已有配置：只补缺失项，同名 provider 与默认模型保持用户原值，注释保留
 * - 一次性：注入后再次启动不改动，用户删除的 provider 不会被复原
 * - 健壮性：settings.yaml 语法错误时原文件原样保留
 * - 兼容性：产物能被内置 dsh 自带的 yaml 解析器解析
 *
 * 运行：node scripts/harness-defaults-selftest.cjs
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { parseDocument } = require('yaml')
const defaults = require('../electron/harness-defaults')

let failed = 0
const check = (name, cond, detail) => {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${name}${detail ? `  ${detail}` : ''}`)
  if (!cond) failed++
}
const read = (file) => fs.readFileSync(file, 'utf8')
const js = (text) => parseDocument(text).toJS()

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-defaults-selftest-'))
const settingsFile = (home) => path.join(home, 'settings.yaml')

try {
  // ── D1 全新主目录：注入内置 provider 与默认模型，且不含密钥 ──
  const home1 = path.join(tmp, 'fresh')
  const r1 = defaults.ensureDefaultSettings({ home: home1 })
  check('D1a 全新主目录写入 settings.yaml', r1.changed && fs.existsSync(settingsFile(home1)),
    `changed=${r1.changed} injected=${r1.injected.join(',')}`)
  const text1 = read(settingsFile(home1))
  const doc1 = js(text1)
  const providers1 = doc1['llm-pi-ai'] && doc1['llm-pi-ai'].providers
  check('D1b 注入汉印 provider', providers1 && providers1.hprt && providers1.hprt.displayName === '汉印',
    providers1 && providers1.hprt && providers1.hprt.baseURL)
  check('D1c 注入智谱 provider', !!(providers1 && providers1['zai-coding-cn']))
  check('D1d 注入默认模型', doc1['agent-default-model'] && doc1['agent-default-model'].provider === 'hprt',
    JSON.stringify(doc1['agent-default-model']))
  check('D1e 只写凭据名、不含密钥值', providers1.hprt.apiKeyEnv === 'HPRT_API_KEY' && !/sk-[A-Za-z0-9]|7aa4e4cf/.test(text1))

  // ── D2 已有用户配置：补缺失项，保留原值与原注释 ──
  const home2 = path.join(tmp, 'existing')
  fs.mkdirSync(home2, { recursive: true })
  const original2 = [
    '# 用户注释：请保留',
    'llm-pi-ai:',
    '  providers:',
    '    foo:',
    '      apiKeyEnv: FOO_KEY',
    'agent-default-model:',
    '  provider: deepseek',
    '  model: deepseek-chat',
    '',
  ].join('\n')
  fs.writeFileSync(settingsFile(home2), original2)
  const r2 = defaults.ensureDefaultSettings({ home: home2 })
  const text2 = read(settingsFile(home2))
  const doc2 = js(text2)
  const providers2 = doc2['llm-pi-ai'].providers
  check('D2a 保留用户 provider', providers2.foo && providers2.foo.apiKeyEnv === 'FOO_KEY')
  check('D2b 补齐内置 provider', !!providers2.hprt && !!providers2['zai-coding-cn'], r2.injected.join(','))
  check('D2c 不覆盖用户默认模型', doc2['agent-default-model'].model === 'deepseek-chat')
  check('D2d 保留用户注释', text2.includes('# 用户注释：请保留'))

  // ── D3 同名 provider 已被用户改过：不覆盖 ──
  const home3 = path.join(tmp, 'custom-hprt')
  fs.mkdirSync(home3, { recursive: true })
  fs.writeFileSync(settingsFile(home3), [
    'llm-pi-ai:',
    '  providers:',
    '    hprt:',
    '      displayName: 我改过的汉印',
    '      apiKeyEnv: MY_HPRT_KEY',
    '',
  ].join('\n'))
  defaults.ensureDefaultSettings({ home: home3 })
  const hprt3 = js(read(settingsFile(home3)))['llm-pi-ai'].providers.hprt
  check('D3 不覆盖同名 provider', hprt3.displayName === '我改过的汉印' && hprt3.apiKeyEnv === 'MY_HPRT_KEY',
    JSON.stringify(hprt3))

  // ── D4 一次性注入：二次启动不改动，用户删除的 provider 不被复原 ──
  const r4 = defaults.ensureDefaultSettings({ home: home1 })
  check('D4a 二次调用跳过', !r4.changed && r4.reason === 'already-injected', `reason=${r4.reason}`)
  const doc4 = parseDocument(read(settingsFile(home1)))
  doc4.deleteIn(['llm-pi-ai', 'providers', 'hprt'])
  fs.writeFileSync(settingsFile(home1), doc4.toString())
  defaults.ensureDefaultSettings({ home: home1 })
  const providers4 = js(read(settingsFile(home1)))['llm-pi-ai'].providers
  check('D4b 用户删除后不复原', !providers4.hprt)

  // ── D5 语法错误：原文件原样保留 ──
  const home5 = path.join(tmp, 'broken')
  fs.mkdirSync(home5, { recursive: true })
  const broken = 'llm-pi-ai:\n  providers: [\n'
  fs.writeFileSync(settingsFile(home5), broken)
  const r5 = defaults.ensureDefaultSettings({ home: home5 })
  check('D5a 语法错误不改动原文件', read(settingsFile(home5)) === broken)
  check('D5b 返回 parse-failed', String(r5.reason).startsWith('parse-failed'), `reason=${r5.reason}`)
  check('D5c 语法错误不写标记（下次仍会重试）', !fs.existsSync(defaults.markerPath(home5)))

  // ── D6 产物兼容内置 dsh 自带的 yaml 解析器 ──
  const runtimeYaml = path.join(__dirname, '..', 'build', 'harness-runtime', 'dsh', 'node_modules', 'yaml')
  if (fs.existsSync(runtimeYaml)) {
    const dshYaml = require(runtimeYaml)
    const parsed = dshYaml.parseDocument(text1)
    check('D6 内置 dsh 的 yaml 可解析产物', parsed.errors.length === 0,
      parsed.errors.map((e) => e.message).join('; '))
    const viaDsh = parsed.toJS()
    check('D6b dsh 解析出的 provider 一致',
      viaDsh['llm-pi-ai'].providers.hprt.models[0].id === 'deepseek-v4.1-flash-expires-on-0910')
  } else {
    console.log('  SKIP  D6 内置运行时不存在，跳过 dsh 解析器兼容性检查')
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
process.exit(failed ? 1 : 0)
