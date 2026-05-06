#!/usr/bin/env node
/**
 * After `vite build`, commits and pushes only `docs/` so GitHub Pages (main + /docs) updates.
 * Set SKIP_DOCS_PUSH=1 to only build without git.
 */
import { execSync } from 'node:child_process'

function sh(cmd, opts = {}) {
  execSync(cmd, { stdio: 'inherit', encoding: 'utf8', ...opts })
}

function shSilent(cmd) {
  try {
    execSync(cmd, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

if (process.env.SKIP_DOCS_PUSH === '1') {
  console.log('已略過 git（SKIP_DOCS_PUSH=1）。')
  process.exit(0)
}

if (!shSilent('git rev-parse --git-dir')) {
  console.error('錯誤：不在 git  repository 內，無法 push。請在專案根目錄執行 npm run deploy。')
  process.exit(1)
}

sh('git add docs/')

const hasStagedChanges = !shSilent('git diff --cached --quiet')
if (!hasStagedChanges) {
  console.log('docs/ 相對於上一次 commit 無變更；未建立新 commit。')
  console.log('若網站仍未更新，請到 GitHub → Settings → Pages 確認來源為 branch main、資料夾 /docs，或使用 GitHub Actions。')
  process.exit(0)
}

const msg = `chore: publish docs`
sh(`git commit -m ${JSON.stringify(msg)}`)
sh('git push')
console.log('已將 docs/ commit 並 push；GitHub Pages（若設為 main /docs）約 1–2 分鐘內會更新。')
