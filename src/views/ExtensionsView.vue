<template>
  <div class="settings-page extensions-page">
    <PageHeader eyebrow="EXTENSIONS" title="扩展管理" description="统一管理 Claude Code、Codex、Kimi CLI、Zcode 四个平台的技能与插件。" />

    <div class="extensions-toolbar">
      <el-segmented v-model="activePlatformId" :options="platformOptions" class="settings-sections" />
      <div class="header-actions">
        <span v-if="currentPlatform" class="progress-text">
          技能 {{ enabledSkillCount }}/{{ currentPlatform.skills.length }} · 插件 {{ enabledPluginCount }}/{{ currentPlatform.plugins.length }}
        </span>
        <el-button plain @click="openPlatformDir">
          <el-icon style="margin-right: 4px"><FolderOpened /></el-icon>打开目录
        </el-button>
        <el-button type="primary" plain :loading="loading" @click="loadExtensions">
          <el-icon style="margin-right: 4px"><Refresh /></el-icon>刷新
        </el-button>
      </div>
    </div>

    <el-alert
      v-if="currentPlatform && !currentPlatform.installed"
      type="warning"
      :closable="false"
      show-icon
      class="card"
    >
      未检测到 {{ currentPlatform.name }} 的配置目录（{{ currentPlatform.dir }}），可能尚未安装该平台。
    </el-alert>
    <el-alert
      v-if="currentPlatform && currentPlatform.error"
      type="error"
      :closable="false"
      show-icon
      class="card"
    >
      读取 {{ currentPlatform.name }} 扩展失败：{{ currentPlatform.error }}
    </el-alert>

    <!-- 技能列表 -->
    <el-card shadow="never" class="card extensions-table-card">
      <template #header>
        <div class="card-header">
          <span>技能 Skills（{{ skillRows.length }}）</span>
          <span class="extensions-note">禁用 = 移入 skills-disabled；链接技能的启停会同步其源平台</span>
        </div>
      </template>
      <div class="table-wrap">
        <el-table :data="skillRows" height="100%" size="small">
          <template #empty>
            <div class="table-empty">
              <el-icon><MagicStick /></el-icon>
              <p>未发现任何技能目录</p>
            </div>
          </template>
          <el-table-column label="技能" min-width="180" show-overflow-tooltip>
            <template #default="{ row }">
              <span class="skill-name">{{ row.name }}</span>
              <el-tooltip v-if="row.linkTarget" :content="`链接目标：${row.linkTarget}`" placement="top">
                <el-tag size="small" effect="plain" class="skill-warn-tag">链接</el-tag>
              </el-tooltip>
              <el-tag v-if="row.linkBroken" type="danger" size="small" effect="plain" class="skill-warn-tag">链接失效</el-tag>
              <el-tag v-if="!row.hasSkillMd && !row.linkBroken" type="danger" size="small" effect="plain" class="skill-warn-tag">缺 SKILL.md</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="描述" min-width="280" show-overflow-tooltip>
            <template #default="{ row }">{{ row.description || '-' }}</template>
          </el-table-column>
          <el-table-column label="状态" width="110">
            <template #default="{ row }">
              <el-switch
                :model-value="row.enabled"
                :loading="row.busy"
                :disabled="!row.hasSkillMd && !row.linkBroken"
                @change="toggleSkill(row, $event)"
              />
            </template>
          </el-table-column>
          <el-table-column label="操作" width="150" fixed="right">
            <template #default="{ row }">
              <el-button text size="small" type="primary" :disabled="!row.hasSkillMd" @click="showSkillDoc(row)">查看</el-button>
              <el-button text size="small" @click="openPath(row.dir)">打开目录</el-button>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </el-card>

    <!-- 插件列表 -->
    <el-card v-if="currentPlatform && currentPlatform.pluginsSupported" shadow="never" class="card extensions-table-card">
      <template #header>
        <div class="card-header">
          <span>插件 Plugins（{{ pluginRows.length }}）</span>
          <span class="extensions-note">开关写入各平台自身的启用配置，立即生效</span>
        </div>
      </template>
      <div class="table-wrap">
        <el-table :data="pluginRows" height="100%" size="small">
          <template #empty>
            <div class="table-empty">
              <el-icon><Box /></el-icon>
              <p>未发现已安装的插件</p>
            </div>
          </template>
          <el-table-column label="插件" min-width="200" show-overflow-tooltip>
            <template #default="{ row }">{{ row.name }}</template>
          </el-table-column>
          <el-table-column label="来源市场" min-width="170" show-overflow-tooltip>
            <template #default="{ row }">{{ row.marketplace || '-' }}</template>
          </el-table-column>
          <el-table-column label="版本" width="110">
            <template #default="{ row }">{{ row.version || '-' }}</template>
          </el-table-column>
          <el-table-column label="安装时间" min-width="170" show-overflow-tooltip>
            <template #default="{ row }">{{ formatTime(row.installedAt) }}</template>
          </el-table-column>
          <el-table-column label="状态" width="110">
            <template #default="{ row }">
              <el-switch :model-value="row.enabled" :loading="row.busy" @change="togglePlugin(row, $event)" />
            </template>
          </el-table-column>
          <el-table-column label="操作" width="110" fixed="right">
            <template #default="{ row }">
              <el-button text size="small" :disabled="!row.installPath" @click="openPath(row.installPath)">打开目录</el-button>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </el-card>
    <el-card v-else shadow="never" class="card">
      <template #header>
        <div class="card-header"><span>插件 Plugins</span></div>
      </template>
      <div class="extensions-plugin-empty">{{ currentPlatform?.pluginNote || '该平台暂无插件体系' }}</div>
    </el-card>

    <!-- SKILL.md 预览 -->
    <el-drawer v-model="docVisible" :title="docTitle" size="46%">
      <pre class="skill-doc">{{ docContent }}</pre>
    </el-drawer>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import PageHeader from '../components/PageHeader.vue'

const loading = ref(false)
const platforms = ref([])
const activePlatformId = ref('claude-code')
const docVisible = ref(false)
const docTitle = ref('')
const docContent = ref('')

const currentPlatform = computed(() => platforms.value.find((p) => p.id === activePlatformId.value) || null)
const skillRows = computed(() => currentPlatform.value?.skills || [])
const pluginRows = computed(() => currentPlatform.value?.plugins || [])
const enabledSkillCount = computed(() => skillRows.value.filter((s) => s.enabled).length)
const enabledPluginCount = computed(() => pluginRows.value.filter((p) => p.enabled).length)

const platformOptions = computed(() =>
  platforms.value.map((p) => ({ label: `${p.name}（${p.skills.length}技/${p.plugins.length}插件）`, value: p.id }))
)

async function loadExtensions() {
  loading.value = true
  try {
    const result = await window.gitReport.extensionsList()
    // 保留已展开行的 busy 状态无意义（整表刷新），直接替换并补齐本地交互字段
    platforms.value = (result?.platforms || []).map((p) => ({
      ...p,
      skills: p.skills.map((s) => ({ ...s, busy: false })),
      plugins: p.plugins.map((x) => ({ ...x, busy: false })),
    }))
    if (!platforms.value.some((p) => p.id === activePlatformId.value) && platforms.value.length) {
      activePlatformId.value = platforms.value[0].id
    }
  } catch (error) {
    ElMessage.error(error?.message || '读取扩展列表失败')
  } finally {
    loading.value = false
  }
}

async function toggleSkill(row, enable) {
  row.busy = true
  try {
    const r = await window.gitReport.extensionsToggleSkill(activePlatformId.value, row.name, enable)
    if (!r?.ok) throw new Error(r?.error || '操作失败')
    await loadExtensions()
    ElMessage.success(`技能「${row.name}」已${enable ? '启用' : '禁用'}`)
  } catch (error) {
    ElMessage.error(error?.message || `技能「${row.name}」${enable ? '启用' : '禁用'}失败`)
  } finally {
    row.busy = false
  }
}

async function togglePlugin(row, enable) {
  row.busy = true
  try {
    const r = await window.gitReport.extensionsTogglePlugin(activePlatformId.value, row.id, enable)
    if (!r?.ok) throw new Error(r?.error || '操作失败')
    await loadExtensions()
    ElMessage.success(`插件「${row.name}」已${enable ? '启用' : '禁用'}`)
  } catch (error) {
    ElMessage.error(error?.message || `插件「${row.name}」${enable ? '启用' : '禁用'}失败`)
  } finally {
    row.busy = false
  }
}

async function showSkillDoc(row) {
  try {
    const r = await window.gitReport.extensionsReadSkill(activePlatformId.value, row.name)
    if (!r?.ok) throw new Error(r?.error || '读取失败')
    docTitle.value = `${row.name} · SKILL.md`
    docContent.value = r.hasSkillMd ? r.content : '（该技能目录缺少 SKILL.md）'
    docVisible.value = true
  } catch (error) {
    ElMessage.error(error?.message || '读取技能文档失败')
  }
}

function openPlatformDir() {
  if (currentPlatform.value) openPath(currentPlatform.value.dir)
}

function openPath(p) {
  if (p) window.gitReport.openPath(p)
}

function formatTime(value) {
  if (!value) return '-'
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString('zh-CN', { hour12: false })
}

onMounted(loadExtensions)
</script>

<style scoped>
.extensions-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-shrink: 0;
  gap: 12px;
  flex-wrap: wrap;
}
.extensions-table-card {
  min-height: 300px;
  display: flex;
  flex-direction: column;
}
.extensions-table-card > :deep(.el-card__header) { flex-shrink: 0; }
.extensions-table-card > :deep(.el-card__body) {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.extensions-note {
  font-size: 12px;
  font-weight: 400;
  color: var(--brand-text-sub);
}
.skill-name { font-weight: 500; }
.skill-warn-tag { margin-left: 6px; }
.extensions-plugin-empty {
  font-size: 13px;
  color: var(--brand-text-sub);
}
.skill-doc {
  margin: 0;
  padding: 12px;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 13px;
  line-height: 1.7;
  font-family: inherit;
  background: #f7f8fa;
  border-radius: 8px;
  min-height: 100%;
}
.table-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  color: var(--brand-text-sub);
  padding: 28px 0;
}
.table-empty .el-icon { font-size: 30px; }
.table-empty p { margin: 0; font-size: 13px; }
</style>
