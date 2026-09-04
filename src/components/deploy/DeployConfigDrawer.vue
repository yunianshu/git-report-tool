<template>
  <el-drawer
    :model-value="modelValue"
    title="部署设置"
    size="600px"
    class="deploy-config-drawer"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div class="deploy-config-scroll">
      <el-card shadow="never" class="card">
        <template #header><div class="card-header"><span>基本信息</span></div></template>
        <div class="f-row">
          <span class="f-label">项目名称</span>
          <el-input v-model="form.name" placeholder="如 myapp" style="flex: 1" />
        </div>
        <div class="f-row">
          <span class="f-label">本地目录</span>
          <el-input v-model="form.localPath" placeholder="D:\projects\myapp" style="flex: 1" />
          <el-button @click="browseLocal"><el-icon><Folder /></el-icon></el-button>
        </div>
        <div class="f-row">
          <span class="f-label">Compose</span>
          <el-input v-model="form.composeFile" placeholder="docker-compose.yml" style="flex: 1" />
        </div>
        <div class="f-row">
          <span class="f-label">版本号</span>
          <el-radio-group v-model="form.version.strategy" size="small">
            <el-radio-button value="auto">自动识别</el-radio-button>
            <el-radio-button value="manual">手动指定</el-radio-button>
          </el-radio-group>
          <el-input
            v-if="form.version.strategy === 'manual'"
            v-model="form.version.manual"
            placeholder="如 1.2.3"
            style="width: 140px"
          />
          <el-tag v-else-if="detected.version" type="success" effect="plain" size="small">
            {{ detected.version }}（{{ detected.source }}）
          </el-tag>
          <el-tag v-else type="info" effect="plain" size="small">未识别到版本号</el-tag>
        </div>
        <div class="f-hint">自动识别优先级：VERSION → package.json → pom.xml → build.gradle → pubspec.yaml → *.csproj</div>
      </el-card>

      <!-- 部署目标（多环境） -->
      <el-card shadow="never" class="card">
        <template #header>
          <div class="card-header">
            <span>部署目标（多环境）</span>
            <span class="target-ops">
              <el-button text size="small" type="primary" @click="addTarget"><el-icon><Plus /></el-icon>新增环境</el-button>
              <el-button text size="small" :disabled="!activeTarget" @click="renameTarget">重命名</el-button>
              <el-button text size="small" type="danger" :disabled="form.targets.length <= 1" @click="removeTarget">删除</el-button>
            </span>
          </div>
        </template>
        <div class="target-row">
          <el-select :model-value="activeTargetId" style="width: 220px" placeholder="选择部署目标" @update:model-value="emit('update:activeTargetId', $event)">
            <el-option v-for="t in form.targets" :key="t.id" :value="t.id" :label="t.name || '未命名环境'" />
          </el-select>
          <span v-if="activeTarget" class="target-host mono">
            {{ activeTarget.server.host || '未配置主机' }} → {{ activeTarget.remotePath || '未配置部署目录' }}
          </span>
        </div>
        <div class="f-hint">
          同一项目可配置多个部署目标（测试 / 生产 / 多台服务器），各自独立保存服务器地址、部署目录、
          健康检查与凭据；发布、测试连接、回滚均作用于当前选中的目标。
        </div>
      </el-card>

      <el-card shadow="never" class="card">
        <template #header>
          <div class="card-header"><span>服务器（当前目标）</span></div>
        </template>
        <template v-if="activeTarget">
          <div class="f-row">
            <span class="f-label">主机地址</span>
            <el-input v-model="activeTarget.server.host" placeholder="192.168.1.100 或 server.example.com" style="flex: 1" />
            <el-input-number v-model="activeTarget.server.port" :min="1" :max="65535" controls-position="right" style="width: 100px" />
          </div>
          <div class="f-row">
            <span class="f-label">用户名</span>
            <el-input v-model="activeTarget.server.username" placeholder="root" style="width: 200px" />
            <el-radio-group v-model="activeTarget.server.authType" size="small">
              <el-radio-button value="password">密码</el-radio-button>
              <el-radio-button value="key">私钥</el-radio-button>
            </el-radio-group>
          </div>
          <div v-if="activeTarget.server.authType === 'password'" class="f-row">
            <span class="f-label">密码</span>
            <el-input
              v-model="activeTarget.server.secret"
              type="password"
              show-password
              style="flex: 1"
              :placeholder="activeTarget.server.secretConfigured ? `${activeTarget.server.secretMasked}（留空保持不变）` : 'SSH 登录密码'"
            />
            <el-button v-if="activeTarget.server.secretConfigured" text type="danger" size="small" @click="activeTarget.server.clearSecret = true">
              清除
            </el-button>
          </div>
          <template v-else>
            <div class="f-row">
              <span class="f-label">私钥路径</span>
              <el-input v-model="activeTarget.server.keyPath" placeholder="C:\Users\you\.ssh\id_rsa" style="flex: 1" />
              <el-button @click="browseKey"><el-icon><Folder /></el-icon></el-button>
            </div>
            <div class="f-row">
              <span class="f-label">私钥口令</span>
              <el-input
                v-model="activeTarget.server.passphrase"
                type="password"
                show-password
                style="flex: 1"
                :placeholder="activeTarget.server.passphraseConfigured ? '已保存（留空保持不变）' : '无口令可留空'"
              />
            </div>
          </template>
          <div class="f-row">
            <span class="f-label">部署目录</span>
            <el-input v-model="activeTarget.remotePath" placeholder="/opt/apps/myapp" style="flex: 1" />
          </div>
        </template>
        <div class="f-hint">
          远程部署根目录，可自定义；其下自动创建 releases / uploads / backups / shared / deployer，
          current 软链接指向运行版本。密码经系统加密存储，明文不落盘。
        </div>
      </el-card>

      <el-card shadow="never" class="card">
        <template #header><div class="card-header"><span>部署选项</span></div></template>
        <div class="f-row check-row">
          <el-checkbox v-model="form.deploy.backupCode">发布前备份代码</el-checkbox>
          <el-checkbox v-model="form.deploy.autoRollback">失败自动回滚</el-checkbox>
          <el-checkbox v-model="form.deploy.deleteUploadAfterSuccess">成功后删除上传包</el-checkbox>
        </div>
        <div class="f-row check-row">
          <el-checkbox v-model="form.deploy.backupDatabase">发布前备份数据库</el-checkbox>
          <template v-if="form.deploy.backupDatabase">
            <el-select v-model="form.deploy.dbType" style="width: 110px">
              <el-option value="postgres" label="PostgreSQL" />
              <el-option value="mysql" label="MySQL" />
            </el-select>
            <el-input v-model="form.deploy.dbContainer" placeholder="数据库容器名" style="width: 150px" />
            <el-input v-model="form.deploy.dbName" placeholder="库名" style="width: 130px" />
            <el-input v-model="form.deploy.dbUser" placeholder="用户(可选)" style="width: 120px" />
          </template>
        </div>
        <div class="f-row">
          <span class="f-label">保留数量</span>
          <span class="f-mini">最近</span>
          <el-input-number v-model="form.deploy.keepReleases" :min="1" :max="50" controls-position="right" style="width: 90px" />
          <span class="f-mini">个版本 /</span>
          <el-input-number v-model="form.deploy.keepBackups" :min="1" :max="50" controls-position="right" style="width: 90px" />
          <span class="f-mini">份备份</span>
        </div>
      </el-card>

      <el-card shadow="never" class="card">
        <template #header>
          <div class="card-header"><span>健康检查（当前目标）</span></div>
        </template>
        <template v-if="activeTarget">
          <div class="f-row check-row">
            <el-checkbox v-model="activeTarget.health.enabled">启用 HTTP 健康检查</el-checkbox>
          </div>
          <div class="f-row">
            <span class="f-label">检查地址</span>
            <el-input
              v-model="activeTarget.health.url"
              placeholder="http://127.0.0.1:8080/actuator/health"
              style="flex: 1"
              :disabled="!activeTarget.health.enabled"
            />
          </div>
          <div class="f-row">
            <span class="f-label">超时/间隔</span>
            <el-input-number v-model="activeTarget.health.timeout" :min="10" :max="600" controls-position="right" style="width: 100px" :disabled="!activeTarget.health.enabled" />
            <span class="f-mini">秒内，每</span>
            <el-input-number v-model="activeTarget.health.interval" :min="1" :max="30" controls-position="right" style="width: 90px" :disabled="!activeTarget.health.enabled" />
            <span class="f-mini">秒探测一次</span>
          </div>
        </template>
        <div class="f-hint">未启用时仅检查 Docker 容器运行状态。健康检查地址在服务器本机访问，请使用 127.0.0.1。</div>
      </el-card>
    </div>
    <template #footer>
      <div class="drawer-footer">
        <el-button @click="emit('update:modelValue', false)">取消</el-button>
        <el-button type="primary" :disabled="!form.name" @click="emit('save')"><el-icon><Check /></el-icon>保存部署设置</el-button>
      </div>
    </template>
  </el-drawer>
</template>

<script setup>
import { computed } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { emptyTarget } from './deploy-form'

const props = defineProps({
  /** 抽屉开关（v-model） */
  modelValue: { type: Boolean, default: false },
  /** 部署表单（响应式对象，字段由本组件直接编辑） */
  form: { type: Object, required: true },
  /** 当前编辑的部署目标 id（v-model:active-target-id） */
  activeTargetId: { type: String, default: '' },
  /** 自动识别的版本号 { version, source } */
  detected: { type: Object, default: () => ({ version: '', source: '' }) },
})
const emit = defineEmits(['update:modelValue', 'update:activeTargetId', 'save', 'reset-conn'])

/** 当前编辑的部署目标（响应式：切换目标后服务器/健康检查卡随之切换） */
const activeTarget = computed(() => {
  const t = props.form.targets.find((x) => x.id === props.activeTargetId)
  return t || props.form.targets[0] || null
})

// ─── 部署目标（多环境）管理 ───
async function addTarget() {
  const t = emptyTarget()
  t.name = `环境 ${props.form.targets.length + 1}`
  props.form.targets.push(t)
  emit('update:activeTargetId', t.id)
  emit('reset-conn')
  ElMessage.success(`已添加「${t.name}」，填写服务器信息后记得保存配置`)
}

async function renameTarget() {
  const t = activeTarget.value
  if (!t) return
  try {
    const { value } = await ElMessageBox.prompt('环境名称（如：测试 / 生产）', '重命名目标', {
      inputValue: t.name, confirmButtonText: '确定', cancelButtonText: '取消',
      inputPattern: /\S+/, inputErrorMessage: '名称不能为空',
    })
    t.name = value.trim()
  } catch { /* 取消 */ }
}

async function removeTarget() {
  const t = activeTarget.value
  if (!t || props.form.targets.length <= 1) return
  try {
    await ElMessageBox.confirm(
      `确认删除目标「${t.name}」（${t.server.host || '未配置主机'}）？仅删除该环境的配置，不影响服务器。`,
      '删除目标', { type: 'warning' },
    )
  } catch { return }
  const i = props.form.targets.indexOf(t)
  props.form.targets.splice(i, 1)
  if (props.activeTargetId === t.id) emit('update:activeTargetId', props.form.targets[Math.max(0, i - 1)].id)
  ElMessage.success('已删除目标')
}

async function browseLocal() {
  const dir = await window.gitReport.pickDirectory()
  if (dir) props.form.localPath = dir
}
async function browseKey() {
  const dir = await window.gitReport.pickDirectory()
  if (dir && activeTarget.value) activeTarget.value.server.keyPath = dir
}
</script>

<style scoped>
.f-row { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; flex-wrap: wrap; }
.f-row:last-child { margin-bottom: 0; }
.f-label { width: 76px; flex-shrink: 0; font-size: 13px; color: #4a5160; text-align: right; }
.f-mini { font-size: 12.5px; color: var(--brand-text-sub); }
.check-row { gap: 16px; }

.target-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.target-ops { display: inline-flex; align-items: center; gap: 2px; }
</style>
