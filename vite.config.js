import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// GitHub project page: https://kevin7261.github.io/KDrawer/
// Relative base so assets work whether Pages serves repo root + /docs/ URL or branch folder /docs.
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
