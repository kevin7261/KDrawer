import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// GitHub project page: https://kevin7261.github.io/KDrawer/
// Build output must live in /docs (branch deploy) or match Actions artifact path.
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
