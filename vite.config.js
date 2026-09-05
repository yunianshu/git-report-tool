import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

export default defineConfig({
  plugins: [vue()],
  base: './',
  define: {
    // 注入应用版本号（设置页「应用信息」展示，避免硬编码过期）
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 1500
  },
  server: {
    port: 5173,
    strictPort: true
  }
})
