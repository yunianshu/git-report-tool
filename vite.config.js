import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

export default defineConfig({
  plugins: [
    vue({
      // <webview> 是 Electron 的 guest 标签，不是 Vue 组件，需按原生自定义元素处理
      template: { compilerOptions: { isCustomElement: (tag) => tag === 'webview' } },
    }),
  ],
  base: './',
  define: {
    // 注入应用版本号（设置页「应用信息」展示，避免硬编码过期）
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 1500,
    // 大依赖独立分包：首屏不需要 echarts（统计页才用），拆分后主包显著变小且利于缓存
    rollupOptions: {
      output: {
        manualChunks: {
          echarts: ['echarts'],
          'element-plus': ['element-plus', '@element-plus/icons-vue'],
        },
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true
  }
})
