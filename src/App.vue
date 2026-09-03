<template>
  <el-container class="app">
    <el-aside width="200px" class="aside">
      <div class="logo">Dev<b>·</b>工具箱</div>
      <el-menu :default-active="view" class="menu" @select="(i) => (view = i)">
        <el-menu-item-group title="Git 报告">
          <el-menu-item index="chat">
            <el-icon><ChatDotRound /></el-icon><span>AI 助手</span>
          </el-menu-item>
          <el-menu-item index="report">
            <el-icon><Document /></el-icon><span>报告</span>
          </el-menu-item>
        </el-menu-item-group>
        <el-menu-item-group title="一键部署">
          <el-menu-item index="deploy">
            <el-icon><Promotion /></el-icon><span>OneDeploy</span>
          </el-menu-item>
        </el-menu-item-group>
        <el-menu-item-group title="通用">
          <el-menu-item index="settings">
            <el-icon><Setting /></el-icon><span>设置</span>
          </el-menu-item>
        </el-menu-item-group>
      </el-menu>
      <div class="aside-footer">v1.3.0 · Windows / macOS / Linux</div>
    </el-aside>
    <el-main class="main">
      <transition name="fade" mode="out-in">
        <ChatView v-if="view === 'chat'" key="chat" />
        <ReportView v-else-if="view === 'report'" key="report" />
        <DeployView v-else-if="view === 'deploy'" key="deploy" />
        <SettingsView v-else key="settings" />
      </transition>
    </el-main>
  </el-container>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import ChatView from './views/ChatView.vue'
import ReportView from './views/ReportView.vue'
import DeployView from './views/DeployView.vue'
import SettingsView from './views/SettingsView.vue'
import { state } from './store'
import { toPlain } from './utils/ipc'
import { shortPath } from './utils/path'

const view = ref('chat')

onMounted(async () => {
  try {
    const cfg = await window.gitReport.configLoad()
    if (cfg) {
      // 迁移旧版单身份配置 → identities 列表
      if (cfg.myIdentity && (cfg.myIdentity.name || cfg.myIdentity.email) && (!cfg.identities || !cfg.identities.length)) {
        cfg.identities = [cfg.myIdentity]
      }
      // 首次启动：无身份时读取本机全局 git 身份作为默认
      if (!cfg.identities || !cfg.identities.length) {
        const identity = await window.gitReport.getIdentity()
        if (identity.name || identity.email) cfg.identities = [identity]
      }
      delete cfg.myIdentity
      if (!Array.isArray(cfg.identities)) cfg.identities = []
      await window.gitReport.configSave(toPlain(cfg))
      state.config = { ...state.config, ...cfg }
    }
    // 生成过程进度监听（App 常驻，切换视图不中断进度显示）
    window.gitReport.onScanProgress((p) => { state.report.scanProgress = p })
    window.gitReport.onCollectProgress((p) => { state.report.collectProgress = p })
    // 一键部署：发布过程事件订阅（App 常驻，切换视图不中断日志/阶段显示）
    window.gitReport.onDeployLog((l) => {
      state.deploy.logs.push(l)
      if (state.deploy.logs.length > 2000) state.deploy.logs.splice(0, state.deploy.logs.length - 2000)
    })
    window.gitReport.onDeployStage((s) => {
      if (state.deploy.stages[s.stage]) state.deploy.stages[s.stage].status = s.status
    })
    window.gitReport.onDeployProgress((p) => {
      if (p.kind === 'package') state.deploy.packageCount = p.count || 0
      if (p.kind === 'upload') state.deploy.uploadPercent = p.percent || 0
    })
    window.gitReport.onDeployDone((d) => {
      state.deploy.running = false
      if (d && d.record && d.record.status === 'success') state.deploy.currentVersion = d.record.version
    })
    // 接收启动预热结果：仓库列表直接就绪，点「生成报告」时无需再等扫描
    window.gitReport.warmup().then((repos) => {
      if (Array.isArray(repos) && repos.length && !state.discoveredRepos.length) {
        state.discoveredRepos = repos.map((p) => ({ path: p, shortName: shortPath(p), info: null }))
      }
    }).catch(() => { /* 预热失败静默，生成报告时走正常路径 */ })
  } catch (e) {
    console.error('加载配置失败', e)
  }
})
</script>
