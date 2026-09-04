/**
 * 扩展管理服务自测（无框架，node scripts/extensions-selftest.cjs 直接运行）
 *
 * 验证策略：注入临时目录作为「主目录」，对真实文件系统执行真实读写（非 Mock），
 * 覆盖四个平台的技能目录迁移与插件配置写入；最后对真实用户主目录做一次只读冒烟。
 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const extensionsService = require('../electron/extensions-service')

function writeSkill(dir, name, meta = {}) {
  const skillDir = path.join(dir, name)
  fs.mkdirSync(skillDir, { recursive: true })
  const lines = Object.entries(meta).map(([k, v]) => `${k}: ${v}`)
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    `---\n${lines.join('\n')}\n---\n\n# 正文\n`,
    'utf8'
  )
  return skillDir
}

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'extensions-selftest-'))
  let passed = 0
  extensionsService.setRoot(tempRoot)

  // 链接本体存在性：existsSync 会跟随链接，悬空链接必须用 lstat 判断
  const linkExists = (p) => {
    try {
      fs.lstatSync(p)
      return true
    } catch {
      return false
    }
  }
  // 链接目标比较：容忍尾部分隔符与大小写差异（不同 Node/libuv 建链行为不一）
  const normPath = (p) => path.normalize(p).replace(/[\\/]+$/, '').toLowerCase()

  try {
    // ── 1. 技能列表：frontmatter 解析 + 启用/禁用目录识别 ──
    const claudeSkills = path.join(tempRoot, '.claude', 'skills')
    const claudeDisabled = path.join(tempRoot, '.claude', 'skills-disabled')
    writeSkill(claudeSkills, 'daily-report', { name: 'daily-report', description: '生成工作日报' })
    writeSkill(claudeSkills, 'no-meta') // 缺 frontmatter 也要列出
    fs.mkdirSync(path.join(claudeSkills, 'loose-file'), { recursive: true })
    fs.writeFileSync(path.join(claudeSkills, 'loose-file', 'readme.txt'), 'x', 'utf8')
    fs.mkdirSync(claudeDisabled, { recursive: true })
    writeSkill(claudeDisabled, 'old-skill', { description: '被禁用的技能' })

    const listed = extensionsService.listAll()
    const claude = listed.platforms.find((p) => p.id === 'claude-code')
    assert.strictEqual(listed.platforms.length, 4, '应返回四个平台')
    assert.strictEqual(claude.name, 'Claude Code')
    const byName = Object.fromEntries(claude.skills.map((s) => [s.name, s]))
    assert.strictEqual(byName['daily-report'].enabled, true, 'skills 目录下的技能应为启用态')
    assert.strictEqual(byName['daily-report'].description, '生成工作日报', '应解析出描述')
    assert.strictEqual(byName['old-skill'].enabled, false, 'skills-disabled 下的技能应为禁用态')
    assert.strictEqual(byName['loose-file'].hasSkillMd, false, '缺 SKILL.md 的目录应标记 hasSkillMd=false')
    assert.strictEqual(claude.pluginsSupported, true)
    passed += 1
    console.log('  ✓ 技能列表扫描：frontmatter 解析与启用/禁用目录识别正确')

    // ── 2. 禁用→启用→再禁用（可逆，真实目录迁移） ──
    extensionsService.toggleSkill('claude-code', 'daily-report', false)
    assert.ok(fs.existsSync(path.join(claudeDisabled, 'daily-report', 'SKILL.md')), '禁用后目录应迁入 skills-disabled')
    assert.ok(!fs.existsSync(path.join(claudeSkills, 'daily-report')), '启用目录中不应再存在该技能')
    extensionsService.toggleSkill('claude-code', 'daily-report', true)
    assert.ok(fs.existsSync(path.join(claudeSkills, 'daily-report', 'SKILL.md')), '重新启用后目录应迁回 skills')
    extensionsService.toggleSkill('claude-code', 'daily-report', false)
    const afterDisable = extensionsService.listAll().platforms.find((p) => p.id === 'claude-code')
    assert.strictEqual(afterDisable.skills.find((s) => s.name === 'daily-report').enabled, false)
    extensionsService.toggleSkill('claude-code', 'daily-report', true)
    passed += 1
    console.log('  ✓ 技能禁用/启用为真实目录迁移且可逆')

    // ── 3. 异常路径：不存在、同名冲突、路径穿越、未知平台 ──
    assert.throws(() => extensionsService.toggleSkill('claude-code', 'ghost', true), /未找到/, '不存在的技能应报错')
    writeSkill(claudeDisabled, 'conflict-x')
    fs.mkdirSync(path.join(claudeSkills, 'conflict-x'), { recursive: true })
    assert.throws(() => extensionsService.toggleSkill('claude-code', 'conflict-x', true), /同名/, '同名冲突应拒绝且不覆盖')
    assert.ok(fs.existsSync(path.join(claudeDisabled, 'conflict-x', 'SKILL.md')), '冲突时源目录必须原样保留')
    for (const bad of ['..', 'a/b', 'a\\b', '', 'a:b']) {
      assert.throws(() => extensionsService.toggleSkill('claude-code', bad, true), /非法|不能为空/, `非法名称「${bad}」应被拒绝`)
    }
    assert.throws(() => extensionsService.toggleSkill('evil-platform', 'x', true), /未知平台/)
    passed += 1
    console.log('  ✓ 异常输入（不存在/同名冲突/路径穿越/未知平台）全部拒绝且无副作用')

    // ── 4. Claude 插件：注册表读取 + settings.json 开关（其他字段必须保留） ──
    const claudePluginsDir = path.join(tempRoot, '.claude', 'plugins')
    fs.mkdirSync(claudePluginsDir, { recursive: true })
    fs.writeFileSync(path.join(claudePluginsDir, 'installed_plugins.json'), JSON.stringify({
      version: 2,
      plugins: {
        'glm-plan-usage@zai-coding-plugins': [{ scope: 'user', installPath: 'C:\\x\\glm-plan-usage\\0.0.1', version: '0.0.1', installedAt: '2026-01-14T02:51:19.805Z' }],
        'github@claude-plugins-official': [{ scope: 'user', installPath: 'C:\\x\\github\\1.0.0', version: '1.0.0', installedAt: '2026-06-16T03:15:27.503Z' }],
      },
    }), 'utf8')
    const claudeSettingsPath = path.join(tempRoot, '.claude', 'settings.json')
    fs.writeFileSync(claudeSettingsPath, JSON.stringify({
      enabledPlugins: { 'github@claude-plugins-official': false },
      outputStyle: 'engineer-professional',
      autoUpdatesChannel: 'latest',
    }, null, 2) + '\n', 'utf8')

    let claudePlugins = extensionsService.listAll().platforms.find((p) => p.id === 'claude-code').plugins
    assert.strictEqual(claudePlugins.length, 2)
    assert.strictEqual(claudePlugins.find((x) => x.id === 'glm-plan-usage@zai-coding-plugins').enabled, true, '未写入开关的插件默认启用')
    assert.strictEqual(claudePlugins.find((x) => x.id === 'github@claude-plugins-official').enabled, false, 'settings.json 中 false 的插件为禁用')

    extensionsService.togglePlugin('claude-code', 'github@claude-plugins-official', true)
    const savedSettings = JSON.parse(fs.readFileSync(claudeSettingsPath, 'utf8'))
    assert.strictEqual(savedSettings.enabledPlugins['github@claude-plugins-official'], true)
    assert.strictEqual(savedSettings.outputStyle, 'engineer-professional', 'settings.json 其他字段必须保留')
    assert.strictEqual(savedSettings.autoUpdatesChannel, 'latest')
    extensionsService.togglePlugin('claude-code', 'github@claude-plugins-official', false)
    assert.strictEqual(JSON.parse(fs.readFileSync(claudeSettingsPath, 'utf8')).enabledPlugins['github@claude-plugins-official'], false)
    assert.throws(() => extensionsService.togglePlugin('claude-code', '../evil', true), /非法/, '插件 ID 非法应拒绝')
    passed += 1
    console.log('  ✓ Claude 插件：注册表读取与 settings.json 开关写入且其他字段无损')

    // ── 5. Claude settings.json 损坏时必须拒绝写入（保护用户配置） ──
    fs.writeFileSync(claudeSettingsPath, '{oops', 'utf8')
    assert.throws(() => extensionsService.togglePlugin('claude-code', 'github@claude-plugins-official', true), /解析失败/)
    assert.strictEqual(fs.readFileSync(claudeSettingsPath, 'utf8'), '{oops', '损坏文件必须原样保留，不得覆盖')
    fs.writeFileSync(claudeSettingsPath, JSON.stringify({ enabledPlugins: {}, outputStyle: 'x' }, null, 2) + '\n', 'utf8')
    passed += 1
    console.log('  ✓ Claude settings.json 损坏时拒绝写入并保留原文件')

    // ── 6. Zcode 插件：v1 数组注册表 + cli/config.json 嵌套 enabledPlugins（mcp 字段保留） ──
    const zcodeCli = path.join(tempRoot, '.zcode', 'cli')
    fs.mkdirSync(path.join(zcodeCli, 'plugins'), { recursive: true })
    fs.writeFileSync(path.join(zcodeCli, 'plugins', 'installed_plugins.json'), JSON.stringify({
      version: 1,
      plugins: [
        { id: 'example-plugin@zcode-plugins-official', name: 'example-plugin', marketplace: 'zcode-plugins-official', version: '0.2.0', installPath: 'C:\\z\\example-plugin\\0.2.0', installedAt: '2026-08-11T06:16:21.990Z' },
      ],
    }), 'utf8')
    const zcodeConfigPath = path.join(zcodeCli, 'config.json')
    fs.writeFileSync(zcodeConfigPath, JSON.stringify({
      plugins: { enabledPlugins: { 'example-plugin@zcode-plugins-official': true } },
      mcp: { servers: { 'open-websearch': { enabled: true, command: 'npx' } } },
    }, null, 2) + '\n', 'utf8')

    extensionsService.togglePlugin('zcode', 'example-plugin@zcode-plugins-official', false)
    const zcodeConfig = JSON.parse(fs.readFileSync(zcodeConfigPath, 'utf8'))
    assert.strictEqual(zcodeConfig.plugins.enabledPlugins['example-plugin@zcode-plugins-official'], false)
    assert.strictEqual(zcodeConfig.mcp.servers['open-websearch'].command, 'npx', 'cli/config.json 其他字段必须保留')
    assert.strictEqual(extensionsService.listAll().platforms.find((p) => p.id === 'zcode').plugins[0].enabled, false)
    extensionsService.togglePlugin('zcode', 'example-plugin@zcode-plugins-official', true)
    passed += 1
    console.log('  ✓ Zcode 插件：config.json 嵌套开关写入且 mcp 等其他字段无损')

    // ── 7. Codex 插件：config.toml 行级翻转 + 缺失段追加 + EOL 保留 + 版本补充 ──
    const codexDir = path.join(tempRoot, '.codex')
    fs.mkdirSync(path.join(codexDir, 'plugins', 'cache', 'openai-bundled', 'computer-use', '26.825.31414'), { recursive: true })
    fs.mkdirSync(path.join(codexDir, 'plugins', 'cache', 'openai-bundled', 'chrome', '0.0.9'), { recursive: true })
    fs.mkdirSync(path.join(codexDir, 'plugins', 'cache', 'openai-bundled', 'chrome', '26.825.31414'), { recursive: true })
    const codexConfigPath = path.join(codexDir, 'config.toml')
    fs.writeFileSync(codexConfigPath, [
      'default_model = "gpt-5"',
      '',
      '[projects."D:\\work"]',
      'trust_level = "trusted"',
      '',
      '[plugins."chrome@openai-bundled"]',
      'enabled = true',
      '',
      '[plugins."github@openai-curated"]',
      'enabled = false # 手动关闭',
      '',
      '[plugins."superpowers@openai-curated"]',
      'enabled = true',
      '[plugins."superpowers@openai-curated".extra]', // 子表不得被误当作 enabled 落点
      'flag = 1',
      '',
      '[desktop]',
      'appearanceTheme = "dark"',
      '',
    ].join('\n'), 'utf8')

    let codexPlugins = extensionsService.listAll().platforms.find((p) => p.id === 'codex').plugins
    const codexById = Object.fromEntries(codexPlugins.map((x) => [x.id, x]))
    assert.strictEqual(codexPlugins.length, 3)
    assert.strictEqual(codexById['chrome@openai-bundled'].enabled, true)
    assert.strictEqual(codexById['github@openai-curated'].enabled, false, '带行尾注释的 enabled=false 应正确解析')
    assert.ok(!('computer-use@openai-bundled' in codexById), '仅存在于缓存而未配置的插件不应列出')
    assert.strictEqual(codexById['chrome@openai-bundled'].version, '26.825.31414', '版本应从缓存目录字典序最大者补充')

    extensionsService.togglePlugin('codex', 'github@openai-curated', true)
    let toml = fs.readFileSync(codexConfigPath, 'utf8')
    assert.ok(/\[plugins\."github@openai-curated"\]\nenabled = true\n/.test(toml), 'github 段应翻转为 true')
    assert.ok(toml.includes('enabled = false # 手动关闭') === false, '旧 enabled 行应被替换')
    assert.ok(toml.includes('appearanceTheme = "dark"'), '文件其余内容必须保留')
    assert.ok(toml.includes('default_model = "gpt-5"'))
    assert.ok(!toml.includes('\r'), 'LF 文件不应被改写为 CRLF')

    extensionsService.togglePlugin('codex', 'chrome@openai-bundled', false)
    toml = fs.readFileSync(codexConfigPath, 'utf8')
    assert.ok(/\[plugins\."chrome@openai-bundled"\]\nenabled = false\n/.test(toml))
    assert.ok(/\[plugins\."github@openai-curated"\]\nenabled = true\n/.test(toml), '只允许改动目标段')

    extensionsService.togglePlugin('codex', 'new-plugin@personal', false) // 不存在的段 → 追加
    toml = fs.readFileSync(codexConfigPath, 'utf8')
    assert.ok(/\[plugins\."new-plugin@personal"\]\nenabled = false\n$/.test(toml + '\n') || toml.trimEnd().endsWith('enabled = false'), '新段应追加到文件末尾')
    assert.strictEqual(extensionsService.parseCodexPluginSections(toml)['superpowers@openai-curated'], true, '子表之后的主段 enabled 解析不受影响')

    // CRLF 文件保持 CRLF
    fs.writeFileSync(codexConfigPath, 'a = 1\r\n\r\n[plugins."x@y"]\r\nenabled = true\r\n', 'utf8')
    extensionsService.togglePlugin('codex', 'x@y', false)
    assert.ok(fs.readFileSync(codexConfigPath, 'utf8').includes('\r\n'), 'CRLF 文件的换行风格必须保留')
    passed += 1
    console.log('  ✓ Codex 插件：config.toml 定向翻转/追加/子表隔离/EOL 保留全部正确')

    // ── 8. Kimi：无插件体系；四平台总体结构 ──
    writeSkill(path.join(tempRoot, '.kimi', 'skills'), 'kimi-webbridge', { description: 'Kimi 桥接' })
    const all = extensionsService.listAll()
    const kimi = all.platforms.find((p) => p.id === 'kimi-cli')
    assert.strictEqual(kimi.pluginsSupported, false)
    assert.strictEqual(kimi.plugins.length, 0)
    assert.throws(() => extensionsService.togglePlugin('kimi-cli', 'x@y', true), /插件体系/)
    assert.ok(all.platforms.find((p) => p.id === 'zcode').skillsSupported)
    passed += 1
    console.log('  ✓ Kimi 无插件体系时的降级提示与整体结构正确')

    // ── 9. 链接聚合层级联：junction 技能启停同步源平台 ──
    const zcodeSkills = path.join(tempRoot, '.zcode', 'skills')
    const zcodeDisabled = path.join(tempRoot, '.zcode', 'skills-disabled')
    fs.mkdirSync(zcodeSkills, { recursive: true })
    fs.symlinkSync(path.join(claudeSkills, 'daily-report'), path.join(zcodeSkills, 'daily-report'), 'junction')
    fs.symlinkSync(path.join(claudeSkills, 'daily-report'), path.join(zcodeSkills, 'alias-name'), 'junction') // 别名链接
    const externalDir = path.join(tempRoot, 'external-skill-src')
    writeSkill(tempRoot, 'external-skill-src', { description: '外部技能' })
    fs.symlinkSync(externalDir, path.join(zcodeSkills, 'ext-link'), 'junction') // 外部目标：不级联
    fs.mkdirSync(zcodeDisabled, { recursive: true })
    fs.symlinkSync(claudeDisabled, path.join(zcodeDisabled, 'old-skill'), 'junction') // 指向 skills-disabled 的目录级链接：不级联

    const zcodeListed = extensionsService.listAll().platforms.find((p) => p.id === 'zcode')
    const zcodeDaily = zcodeListed.skills.find((s) => s.name === 'daily-report')
    assert.ok(zcodeDaily, 'junction 技能应被扫描到')
    assert.strictEqual(zcodeDaily.description, '生成工作日报', 'junction 技能的 SKILL.md 应可读')
    assert.ok(zcodeDaily.linkTarget, '列表应携带链接目标信息')

    // 禁用：链接本体 + 源平台真实目录同步进入禁用位（链接因源被移走而暂时悬空）
    extensionsService.toggleSkill('zcode', 'daily-report', false)
    assert.ok(linkExists(path.join(zcodeDisabled, 'daily-report')), '禁用应移动链接本体')
    assert.ok(fs.existsSync(path.join(claudeDisabled, 'daily-report', 'SKILL.md')), '源平台真实目录应同步禁用')
    assert.ok(!fs.existsSync(path.join(claudeSkills, 'daily-report')), '源平台启用目录应清空')

    // 启用：先恢复源平台目录，再重建指向新位置的链接
    extensionsService.toggleSkill('zcode', 'daily-report', true)
    assert.ok(fs.existsSync(path.join(claudeSkills, 'daily-report', 'SKILL.md')), '源平台真实目录应同步恢复')
    assert.strictEqual(
      normPath(fs.readlinkSync(path.join(zcodeSkills, 'daily-report'))),
      normPath(path.join(claudeSkills, 'daily-report')),
      '重建的链接应指向源平台启用目录'
    )
    assert.ok(fs.existsSync(path.join(zcodeSkills, 'daily-report', 'SKILL.md')), '通过新链接应可读到 SKILL.md')

    // 别名链接：源目录按链接目标名迁移，链接按自身名称迁移/重建
    extensionsService.toggleSkill('zcode', 'alias-name', false)
    assert.ok(fs.existsSync(path.join(claudeDisabled, 'daily-report', 'SKILL.md')), '别名禁用应迁移源目录 daily-report')
    assert.ok(linkExists(path.join(zcodeDisabled, 'alias-name')), '别名链接本体应迁移')
    extensionsService.toggleSkill('zcode', 'alias-name', true)
    assert.ok(fs.existsSync(path.join(claudeSkills, 'daily-report', 'SKILL.md')))
    assert.strictEqual(path.basename(fs.readlinkSync(path.join(zcodeSkills, 'alias-name'))), 'daily-report', '别名链接重建后应指向源技能')

    // 级联回滚（禁用向）：链接落点冲突时报错，源目录回滚到启用位
    fs.mkdirSync(path.join(zcodeDisabled, 'alias-name'), { recursive: true })
    assert.throws(() => extensionsService.toggleSkill('zcode', 'alias-name', false), /移动链接失败|同名/, '禁用落点冲突应报错')
    assert.ok(fs.existsSync(path.join(claudeSkills, 'daily-report', 'SKILL.md')), '失败后源目录必须回滚到启用位')
    fs.rmSync(path.join(zcodeDisabled, 'alias-name'), { recursive: true, force: true })

    // 级联回滚（启用向）：链接落点冲突时报错，源目录回滚到禁用位
    extensionsService.toggleSkill('zcode', 'alias-name', false)
    fs.mkdirSync(path.join(zcodeSkills, 'alias-name'), { recursive: true })
    assert.throws(() => extensionsService.toggleSkill('zcode', 'alias-name', true), /重建链接失败|同名/, '启用落点冲突应报错')
    assert.ok(fs.existsSync(path.join(claudeDisabled, 'daily-report', 'SKILL.md')), '失败后源目录必须回滚到禁用位')
    fs.rmSync(path.join(zcodeSkills, 'alias-name'), { recursive: true, force: true })
    extensionsService.toggleSkill('zcode', 'alias-name', true)

    // 外部目标：仅移动链接，外部目录不动
    extensionsService.toggleSkill('zcode', 'ext-link', false)
    assert.ok(fs.existsSync(path.join(externalDir, 'SKILL.md')), '外部目标目录不得被移动')
    assert.ok(fs.existsSync(path.join(zcodeDisabled, 'ext-link')), '外部链接仅迁移链接本体')
    extensionsService.toggleSkill('zcode', 'ext-link', true)

    // 悬空链接：源平台直接禁用后，zcode 列表保留条目并标记 linkBroken，仍可开关（不级联）
    extensionsService.toggleSkill('claude-code', 'daily-report', false)
    const broken = extensionsService.listAll().platforms.find((p) => p.id === 'zcode')
      .skills.find((s) => s.name === 'daily-report')
    assert.ok(broken && broken.enabled && broken.linkBroken, '悬空链接应保留在列表并标记 linkBroken')
    extensionsService.toggleSkill('zcode', 'daily-report', false)
    assert.ok(linkExists(path.join(zcodeDisabled, 'daily-report')), '悬空链接禁用仅移动链接本体')
    // 悬空链接重新启用：链接记录的目标若正处源平台禁用位，级联恢复源目录
    extensionsService.toggleSkill('zcode', 'daily-report', true)
    assert.ok(fs.existsSync(path.join(claudeSkills, 'daily-report', 'SKILL.md')), '悬空链接启用应级联恢复源目录')
    const revived = extensionsService.listAll().platforms.find((p) => p.id === 'zcode')
      .skills.find((s) => s.name === 'daily-report')
    assert.ok(revived && !revived.linkBroken && revived.hasSkillMd, '启用后链接应复活且可读')
    passed += 1
    console.log('  ✓ 链接聚合层级联：启停同步源平台，别名/外部/冲突回滚/悬空场景全部正确')

    // ── 10. readSkillDoc：内容读取与异常 ──
    const doc = extensionsService.readSkillDoc('claude-code', 'daily-report')
    assert.ok(doc.content.includes('生成工作日报'))
    assert.strictEqual(doc.enabled, true)
    assert.ok(doc.dir.includes('skills') && !doc.dir.includes('skills-disabled'))
    assert.throws(() => extensionsService.readSkillDoc('claude-code', '../settings.json'), /非法/)
    assert.throws(() => extensionsService.readSkillDoc('claude-code', 'ghost'), /未找到/)
    passed += 1
    console.log('  ✓ SKILL.md 详情读取与异常路径正确')

    // ── 11. 真实环境只读冒烟：真实主目录（绝不写入） ──
    extensionsService.setRoot(os.homedir())
    const real = extensionsService.listAll()
    assert.strictEqual(real.platforms.length, 4)
    for (const p of real.platforms) {
      assert.ok(Array.isArray(p.skills), `${p.name} 技能数组应存在`)
      assert.ok(Array.isArray(p.plugins), `${p.name} 插件数组应存在`)
      assert.ok(['skills', 'skills-disabled'].every((d) => p.dir.endsWith(d) === false), '平台目录不应指向 skills 子目录')
    }
    const realClaude = real.platforms.find((p) => p.id === 'claude-code')
    assert.ok(realClaude.skills.length > 0, '真实环境 Claude Code 应扫描到技能')
    console.log(`  ✓ 真实环境只读冒烟：${real.platforms.map((p) => `${p.name} ${p.skills.length}技/${p.plugins.length}插件`).join('，')}`)

    console.log(`\n扩展管理服务自测通过（${passed} 组断言）`)
  } finally {
    extensionsService.setRoot(os.homedir())
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error('自测失败：', err)
  process.exitCode = 1
})
