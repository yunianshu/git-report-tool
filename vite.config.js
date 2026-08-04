import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  base: './',
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 1500
  },
  server: {
    port: 5173,
    strictPort: true
  }
})
