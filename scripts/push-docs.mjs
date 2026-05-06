#!/usr/bin/env node
/**
 * 與 npm run deploy 搭配：vite build 後只 commit / push `docs/`。
 * GitHub Pages 請設為 branch main → folder `/docs`。
 * SKIP_DOCS_PUSH=1 → 只做 build，不執行 git。
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

function listStagedPaths() {
  try {
    const out = execSync('git diff --cached --name-only', { encoding: 'utf8' })
    return out.trim().split('\n').filter(Boolean)
  } catch {
    return []
  }
}

/** @returns {number|null} commits ahead of upstream, or null if unknown */
function commitsAheadOfUpstream() {
  try {
    const line = execSync('git status -sb', { encoding: 'utf8' }).split('\n')[0] || ''
    const m = line.match(/\[ahead (\d+)\]/)
    return m ? parseInt(m[1], 10) : 0
  } catch {
    return null
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

const nonDocsStaged = listStagedPaths().filter((f) => !f.startsWith('docs/'))
if (nonDocsStaged.length) {
  console.error(
    '錯誤：staging 已有 docs/ 以外的檔案，請先 commit 或執行 git restore --staged … 再 npm run deploy：\n',
    nonDocsStaged.join('\n'),
  )
  process.exit(1)
}

sh('git add docs/')

const hasStagedChanges = !shSilent('git diff --cached --quiet')
if (!hasStagedChanges) {
  const ahead = commitsAheadOfUpstream()
  if (ahead && ahead > 0) {
    console.log(`docs/ 無新變更；目前分支仍領先遠端 ${ahead} 個 commit，改為執行 git push。`)
    sh('git push')
    console.log('已 push。')
    process.exit(0)
  }
  console.log('docs/ 相對於上一次 commit 無變更；未建立新 commit、未 push。')
  console.log('若網站仍未更新，請到 GitHub → Settings → Pages 確認來源為 branch main、資料夾 /docs。')
  process.exit(0)
}

const msg = `chore: publish docs`
sh(`git commit -m ${JSON.stringify(msg)}`)
sh('git push')
console.log('已將 docs/ commit 並 push；GitHub Pages（若設為 main /docs）約 1–2 分鐘內會更新。')
