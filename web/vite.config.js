import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

const API = process.env.VITE_API_TARGET || 'http://localhost:8787'

// 标准前后端：不再打单文件（vite-plugin-singlefile 已移除），
// 数据与照片由后端提供，开发期通过 proxy 同源化。
export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: API, changeOrigin: true },
      '/photos': { target: API, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    reportCompressedSize: false,
  },
})
