/**
 * 通用项目服务。
 *
 * 当前沿用既有 deploy-projects.json 作为兼容存储，避免迁移或丢失用户已有的
 * 部署目标与加密凭据。部署配置只是项目的可选能力，通用项目本身不依赖 Git、
 * Compose 或服务器配置。
 */
const deployProjects = require('./deploy/deploy-projects')

function list() {
  return deployProjects.list()
}

function save(input) {
  const project = deployProjects.normalizeProject(input)
  if (!project.name) return { ok: false, error: '项目名称不能为空' }
  return deployProjects.save(project)
}

function remove(projectId) {
  if (!projectId) return { ok: false, error: '项目 ID 不能为空' }
  return deployProjects.remove(projectId)
}

module.exports = { list, save, remove }
