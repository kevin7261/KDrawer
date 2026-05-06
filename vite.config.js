import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// build → docs/；GitHub Pages 專案站輸出為 /KDrawer/assets/...
export default defineConfig(({ mode }) => ({
  plugins: [
    vue(),
    {
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
  base: mode === 'production' ? '/KDrawer/' : '/',
  build: {
    outDir: 'docs',
    emptyOutDir: true,
  },
  server: {
    port: 8080,
  },
}))
