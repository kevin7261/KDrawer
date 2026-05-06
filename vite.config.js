import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// 正式站：npm run deploy；Pages 請設 main → /docs。production 使用相對 base，避免誤發布整個 repo 時 /repo/docs/ 底下 asset 路徑錯誤。
export default defineConfig(({ mode }) => ({
  plugins: [
    vue(),
    {
      // repo 根 index 若被 Pages 發布會多此轉址；vite build 產出之 docs/index 不包含此段
      name: 'strip-gh-pages-root-redirect',
      apply: 'build',
      transformIndexHtml(html) {
        return html.replace(
          /\s*<!--\s*GH_PAGES_ROOT_REDIRECT\s*-->[\s\S]*?<!--\s*\/GH_PAGES_ROOT_REDIRECT\s*-->\s*/,
          '',
        )
      },
    },
  ],
  base: mode === 'production' ? './' : '/',
  build: {
    outDir: 'docs',
    emptyOutDir: true,
  },
  server: {
    port: 8080,
  },
}))
