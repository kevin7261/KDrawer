import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// 正式站：npm run deploy；Pages 請設 main → /docs。production 使用相對 base，避免誤發布整個 repo 時 /repo/docs/ 底下 asset 路徑錯誤。
export default defineConfig(({ mode }) => ({
  plugins: [vue()],
  base: mode === 'production' ? './' : '/',
  build: {
    outDir: 'docs',
    emptyOutDir: true,
  },
  server: {
    port: 8080,
  },
}))
