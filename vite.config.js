import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// 正式站：一律用 `npm run deploy`（build + 提交並 push `docs/`）；Pages 設 main + /docs。
export default defineConfig(({ mode }) => ({
  plugins: [vue()],
  base: mode === 'production' ? '/KDrawer/' : '/',
  build: {
    outDir: 'docs',
    emptyOutDir: true,
  },
  server: {
    port: 8080,
  },
}))
