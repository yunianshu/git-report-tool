/** 部署表单与历史展示的共享工厂/格式化工具（DeployView 与 deploy 子组件共用） */

export function genId() {
  return `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export function emptyTarget() {
  return {
    id: genId(),
    name: '环境 1',
    server: {
      host: '', port: 22, username: 'root', authType: 'password', keyPath: '',
      secret: '', clearSecret: false, passphrase: '', clearPassphrase: false,
      secretConfigured: false, secretMasked: '', passphraseConfigured: false,
    },
    remotePath: '',
    health: { enabled: true, url: '', timeout: 90, interval: 3 },
  }
}

export function emptyProject() {
  const t = emptyTarget()
  return {
    id: '',
    name: '',
    localPath: '',
    version: { strategy: 'auto', manual: '' },
    composeFile: 'docker-compose.yml',
    deploy: {
      backupCode: true, backupDatabase: false, dbType: 'postgres', dbContainer: '',
      dbName: '', dbUser: '', autoRollback: true, deleteUploadAfterSuccess: true,
      keepReleases: 10, keepBackups: 10,
    },
    targets: [t],
  }
}

export function fmtTime(t) {
  if (!t) return '—'
  const d = new Date(t)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function fmtDur(ms) {
  if (!ms) return '—'
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}
