<template>
  <el-container class="app">
    <el-aside width="200px" class="aside">
      <div class="logo">Git 报告工具</div>
      <el-menu :default-active="view" class="menu" @select="(i) => (view = i)">
        <el-menu-item index="scan">
          <el-icon><FolderOpened /></el-icon><span>仓库扫描</span>
        </el-menu-item>
        <el-menu-item index="report">
          <el-icon><Document /></el-icon><span>报告生成</span>
        </el-menu-item>
      </el-menu>
      <div class="aside-footer">v1.0.0 · Windows / macOS / Linux</div>
    </el-aside>
    <el-main class="main">
      <ScanView v-if="view === 'scan'" />
      <ReportView v-else />
    </el-main>
  </el-container>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import ScanView from './views/ScanView.vue'
import ReportView from './views/ReportView.vue'
import { state } from './store'
import { toPlain } from './utils/ipc'

const view = ref('scan')

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
  } catch (e) {
    console.error('加载配置失败', e)
  }
})
</script>
