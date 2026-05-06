import { execSync } from 'node:child_process'

function run(cmd) {
  execSync(cmd, { stdio: 'inherit', cwd: process.cwd() })
}

function nothingStaged() {
  try {
    execSync('git diff --cached --quiet', { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

try {
  run('git add docs')

  if (nothingStaged()) {
    console.log('[deploy] No changes under docs/ (already committed).')
    process.exit(0)
  }

  run('git commit -m "chore(pages): deploy"')
  run('git push origin HEAD')
  console.log('[deploy] Pushed docs/ on main. GitHub Pages: branch main, folder /docs.')
} catch {
  process.exit(1)
}
