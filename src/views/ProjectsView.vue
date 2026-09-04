<template>
  <div class="page projects-page">
    <PageHeader eyebrow="PROJECTS" title="项目" description="项目是资料、AI、活动报告与部署的统一入口。">
      <template #actions>
        <el-button type="primary" @click="$emit('create-project')"><el-icon><Plus /></el-icon>新建项目</el-button>
      </template>
    </PageHeader>

    <div v-if="state.projects.items.length" class="projects-layout">
      <aside class="project-list-panel">
        <div class="project-list-tools">
          <el-input v-model="query" clearable placeholder="搜索项目" :prefix-icon="Search" />
          <el-select v-model="status" aria-label="筛选状态" style="width: 124px">
            <el-option label="全部状态" value="" />
            <el-option label="进行中" value="active" />
            <el-option label="已暂停" value="paused" />
            <el-option label="已归档" value="archived" />
          </el-select>
        </div>
        <div class="project-list" role="list">
          <button
            v-for="project in filteredProjects" :key="project.id" type="button"
            :class="['project-list-item', { active: project.id === selected?.id }]"
            @click="selectProject(project.id)"
          >
            <span class="project-list-main"><strong>{{ project.name }}</strong><small>{{ project.description || '暂无项目说明' }}</small></span>
            <span class="project-list-meta">{{ projectStatusLabel(project.status) }}</span>
          </button>
          <p v-if="!filteredProjects.length" class="quiet-empty">没有符合筛选条件的项目。</p>
        </div>
      </aside>

      <section v-if="selected" class="project-detail-panel">
        <div class="project-detail-head">
          <div>
            <div class="project-title-line"><h2>{{ selected.name }}</h2><el-tag effect="plain" size="small">{{ projectStatusLabel(selected.status) }}</el-tag></div>
            <p>{{ selected.description || '尚未填写项目说明。' }}</p>
          </div>
          <div class="detail-actions">
            <el-button @click="$emit('edit-project', selected)"><el-icon><Edit /></el-icon>编辑</el-button>
            <el-dropdown trigger="click">
              <el-button aria-label="更多操作"><el-icon><More /></el-icon></el-button>
              <template #dropdown>
                <el-dropdown-menu><el-dropdown-item class="danger-item" @click="confirmRemove">删除项目</el-dropdown-item></el-dropdown-menu>
              </template>
            </el-dropdown>
          </div>
        </div>

        <div v-if="selected.tags?.length" class="project-tags">
          <el-tag v-for="tag in selected.tags" :key="tag" type="info" effect="plain">{{ tag }}</el-tag>
        </div>

        <dl class="project-facts">
          <div><dt>本地目录</dt><dd :title="selected.localPath">{{ selected.localPath || '未关联目录' }}</dd></div>
          <div><dt>Git 活动源</dt><dd>{{ matchedRepos.length ? `${matchedRepos.length} 个仓库` : '未发现' }}</dd></div>
          <div><dt>部署</dt><dd>{{ deploymentConfigured(selected) ? '已配置' : '未配置' }}</dd></div>
          <div><dt>最后更新</dt><dd>{{ formatTime(selected.updatedAt) }}</dd></div>
        </dl>

        <div class="project-section">
          <div class="section-heading"><div><span class="section-kicker">NOTES</span><h3>项目备注</h3></div></div>
          <div v-if="selected.notes" class="project-notes">{{ selected.notes }}</div>
          <button v-else class="inline-empty" type="button" @click="$emit('edit-project', selected)">补充目标、约束与下一步，让 AI 更理解这个项目</button>
        </div>

        <div class="project-section">
          <div class="section-heading"><div><span class="section-kicker">CAPABILITIES</span><h3>项目能力</h3></div></div>
          <div class="project-capabilities">
            <button type="button" @click="$emit('navigate', 'chat')"><span><strong>AI 助手</strong><small>使用项目资料开展分析与规划</small></span><el-icon><ArrowRight /></el-icon></button>
            <button type="button" @click="$emit('navigate', 'report')"><span><strong>活动报告</strong><small>{{ matchedRepos.length ? '查看关联 Git 活动' : '关联目录后可采集 Git 活动' }}</small></span><el-icon><ArrowRight /></el-icon></button>
            <button type="button" @click="$emit('navigate', 'deploy')"><span><strong>部署</strong><small>{{ deploymentConfigured(selected) ? '进入发布工作区' : '需要时再配置部署' }}</small></span><el-icon><ArrowRight /></el-icon></button>
          </div>
        </div>
      </section>
    </div>

    <EmptyState v-else icon="FolderAdd" title="还没有项目" description="创建一个项目，把资料、AI、活动与部署放在同一个上下文中。" action="新建项目" @action="$emit('create-project')" />
  </div>
</template>

<script setup>
import { computed, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Search } from '@element-plus/icons-vue'
import PageHeader from '../components/PageHeader.vue'
import EmptyState from '../components/EmptyState.vue'
import { state } from '../store'
import { useProjects } from '../composables/useProjects'
import { deploymentConfigured, projectStatusLabel, reposForProject } from '../utils/project-context'

defineEmits(['navigate', 'create-project', 'edit-project'])
const query = ref('')
const status = ref('')
const { currentProject, selectProject, removeProject } = useProjects()
const filteredProjects = computed(() => state.projects.items.filter((project) => {
  const haystack = `${project.name} ${project.description} ${(project.tags || []).join(' ')}`.toLowerCase()
  return (!query.value || haystack.includes(query.value.toLowerCase())) && (!status.value || project.status === status.value)
}))
const selected = computed(() => currentProject.value || filteredProjects.value[0] || null)
const matchedRepos = computed(() => reposForProject(selected.value, state.discoveredRepos))

function formatTime(timestamp) {
  if (!timestamp) return '—'
  return new Date(timestamp).toLocaleString('zh-CN', { hour12: false })
}

async function confirmRemove() {
  if (!selected.value) return
  const name = selected.value.name
  try {
    await ElMessageBox.confirm(
      `⚠️ 危险操作检测！\n操作类型：删除项目\n影响范围：项目“${name}”及其本地管理配置\n风险评估：删除后项目不会出现在工作台；本地项目文件不会被删除。`,
      '删除项目',
      { confirmButtonText: '确认删除', cancelButtonText: '取消', type: 'warning' }
    )
    await removeProject(selected.value.id)
    ElMessage.success('项目已删除，本地文件未受影响')
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') ElMessage.error(error?.message || '删除项目失败')
  }
}
</script>
