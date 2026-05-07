import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// build → docs/；專案站網址 https://<user>.github.io/KDrawer/ → base 必須為 '/KDrawer/'
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
}))
