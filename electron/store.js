/**
 * 配置持久化 —— 读写 userData/config.json（避免引入额外依赖）
 */
const { app } = require('electron')
const fs = require('fs')
const path = require('path')

function file() {
  return path.join(app.getPath('userData'), 'config.json')
}

const DEFAULTS = {
  roots: [],
  // 默认勾选常用排除目录，减少扫描范围（与 git-service 默认排除保持一致）
  excludes: [
    'node_modules', 'FlutterSDK', 'fvm_cache', '__MACOSX', 'android-sdk',
    'androidsdk', 'jdk', 'Program Files', 'Pods', '.gradle', '.idea', '.cache',
  ],
  // 本人身份（支持多个账号）：{ name, email } 列表，「只看本人」会匹配所有账号
  identities: [],
}

function load() {
  try {
    const raw = fs.readFileSync(file(), 'utf8')
    return { ...DEFAULTS, ...JSON.parse(raw) }
  } catch {
    return { ...DEFAULTS }
  }
}

function save(cfg) {
  try {
    fs.writeFileSync(file(), JSON.stringify(cfg, null, 2), 'utf8')
    return true
  } catch {
    return false
  }
}

module.exports = { load, save }
