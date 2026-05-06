import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// build 輸出至 docs/；production 用相對路徑以利子路徑或 gh-pages 發佈。
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
