import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// GitHub Project Page: https://kevin7261.github.io/KDrawer/
// Set Pages to "main" + "/docs" folder, or GitHub Actions (workflow uploads `docs/`).
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
