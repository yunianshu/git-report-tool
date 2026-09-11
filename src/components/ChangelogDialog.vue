<template>
  <el-dialog v-model="visible" title="版本更新日志" width="min(760px, 92vw)" top="6vh" destroy-on-close>
    <p class="changelog-current">当前应用版本：v{{ appVersion }} · 日志随应用内置，可离线查看</p>
    <div class="changelog-body" tabindex="0" role="region" aria-label="版本更新日志内容">
      <article v-html="html" />
    </div>
    <template #footer>
      <el-button type="primary" @click="visible = false">关闭</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import changelog from '../../CHANGELOG.md?raw'

const visible = defineModel({ type: Boolean, default: false })
const appVersion = __APP_VERSION__
// 文档是唯一内容来源，构建时内置；清理 HTML 后再展示。
const html = DOMPurify.sanitize(marked.parse(changelog, { async: false, gfm: true }))
</script>

<style scoped>
.changelog-current { margin: 0 0 16px; color: var(--el-text-color-secondary); font-size: 13px; }
.changelog-body { max-height: 60vh; overflow-y: auto; overscroll-behavior: contain; padding: 0 16px 0 4px; line-height: 1.8; color: var(--el-text-color-primary); }
.changelog-body :deep(h1) { font-size: 22px; margin-top: 0; }
.changelog-body :deep(h2) { font-size: 17px; margin: 24px 0 10px; padding-top: 16px; border-top: 1px solid var(--el-border-color-lighter); }
.changelog-body :deep(ul) { padding-left: 22px; }
.changelog-body :deep(li) { margin: 6px 0; }
</style>
