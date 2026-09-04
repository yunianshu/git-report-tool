<template>
  <header class="app-topbar">
    <div class="project-switcher">
      <span class="topbar-label">当前项目</span>
      <el-select
        :model-value="currentId"
        placeholder="全部项目"
        class="project-select"
        @update:model-value="$emit('select-project', $event)"
      >
        <el-option label="全部项目" value="" />
        <el-option
          v-for="project in projects"
          :key="project.id"
          :label="project.name"
          :value="project.id"
        />
      </el-select>
      <el-tag v-if="currentProject" effect="plain" size="small" :type="currentProject.status === 'archived' ? 'info' : 'success'">
        {{ projectStatusLabel(currentProject.status) }}
      </el-tag>
    </div>
    <div class="topbar-actions">
      <span class="data-note">数据仅保存在本机</span>
      <el-button type="primary" @click="$emit('create-project')"><el-icon><Plus /></el-icon>新建项目</el-button>
    </div>
    <!-- 无边框窗口的标题栏按钮（顶栏其余空白区域可拖拽移动窗口） -->
    <div class="win-controls">
      <button class="win-btn" type="button" title="最小化" @click="winMinimize">
        <svg width="12" height="12" viewBox="0 0 12 12"><path d="M1 6h10" stroke="currentColor" stroke-width="1.2"/></svg>
      </button>
      <button class="win-btn" type="button" :title="maximized ? '还原' : '最大化'" @click="winToggleMaximize">
        <svg v-if="maximized" width="12" height="12" viewBox="0 0 12 12"><path d="M3.5 3.5h-2v7h7v-2M3.5 1.5h7v7" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>
        <svg v-else width="12" height="12" viewBox="0 0 12 12"><rect x="1.5" y="1.5" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>
      </button>
      <button class="win-btn win-btn-close" type="button" title="关闭" @click="winClose">
        <svg width="12" height="12" viewBox="0 0 12 12"><path d="M1.5 1.5l9 9M10.5 1.5l-9 9" stroke="currentColor" stroke-width="1.2"/></svg>
      </button>
    </div>
  </header>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { projectStatusLabel } from '../utils/project-context'

const props = defineProps({
  projects: { type: Array, default: () => [] },
  currentId: { type: String, default: '' },
})
defineEmits(['select-project', 'create-project'])
const currentProject = computed(() => props.projects.find((project) => project.id === props.currentId) || null)

const maximized = ref(false)
let offMaximized = null

function winMinimize() { window.gitReport?.winMinimize?.() }
async function winToggleMaximize() {
  const r = await window.gitReport?.winToggleMaximize?.()
  if (typeof r === 'boolean') maximized.value = r
}
function winClose() { window.gitReport?.winClose?.() }

onMounted(async () => {
  maximized.value = !!(await window.gitReport?.winIsMaximized?.())
  offMaximized = window.gitReport?.onWinMaximized?.((v) => { maximized.value = !!v }) || null
})
onBeforeUnmount(() => { if (offMaximized) offMaximized() })
</script>
