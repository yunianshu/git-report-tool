<template>
  <el-container class="app">
    <el-aside width="200px" class="aside">
      <div class="logo">Git<b>·</b>报告</div>
      <el-menu :default-active="view" class="menu" @select="(i) => (view = i)">
        <el-menu-item index="report">
          <el-icon><Document /></el-icon><span>报告</span>
        </el-menu-item>
        <el-menu-item index="settings">
          <el-icon><Setting /></el-icon><span>设置</span>
        </el-menu-item>
      </el-menu>
      <div class="aside-footer">v1.0.2 · Windows / macOS / Linux</div>
    </el-aside>
    <el-main class="main">
      <transition name="fade" mode="out-in">
        <ReportView v-if="view === 'report'" key="report" />
        <SettingsView v-else key="settings" />
      </transition>
    </el-main>
  </el-container>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import ReportView from './views/ReportView.vue'
import SettingsView from './views/SettingsView.vue'
import { state } from './store'
import { toPlain } from './utils/ipc'

const view = ref('report')

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
  } catch (e) {
    console.error('加载配置失败', e)
  }
})
</script>
