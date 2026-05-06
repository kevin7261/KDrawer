import fs from 'node:fs'
import path from 'node:path'

const repoRoot = process.cwd()
const docsDir = path.join(repoRoot, 'docs')
const indexHtml = path.join(docsDir, 'index.html')
const notFoundHtml = path.join(docsDir, '404.html')
const noJekyll = path.join(docsDir, '.nojekyll')

if (!fs.existsSync(indexHtml)) {
  console.error(`[postbuild] Missing ${path.relative(repoRoot, indexHtml)}; did build succeed?`)
  process.exit(1)
}

// GitHub Pages: for SPAs, refreshing a deep link serves 404.html.
// Using the same content as index.html makes routes work after refresh.
fs.copyFileSync(indexHtml, notFoundHtml)

// Ensure .nojekyll exists in the published output (we deploy with --dotfiles too).
if (!fs.existsSync(noJekyll)) {
  fs.writeFileSync(noJekyll, '')
}

console.log('[postbuild] Wrote docs/404.html and ensured docs/.nojekyll')

