// Runs every *.check.ts under the given folders, in parallel, and prints one
// line per file plus a summary. Each check is a plain node script that throws
// on failure, so a non-zero exit is a failing check.
//
//   node scripts/test.mjs api src shared        (root)
//   node ../scripts/test.mjs src ../shared      (mobile/)
//   node scripts/test.mjs shared/voice/agent.check.ts   (one file)
//
// Every check runs with the .js -> .ts resolver and the no-network guard, so a
// test that forgets to fake a vendor fails instead of calling it.
import { spawn } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { cpus } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const roots = process.argv.slice(2)
if (roots.length === 0) {
  console.error('usage: node scripts/test.mjs <dir> [dir...]')
  process.exit(2)
}

function find(dir, out = []) {
  if (!statSync(dir).isDirectory()) return dir.endsWith('.check.ts') ? [dir] : out
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) find(path, out)
    else if (name.endsWith('.check.ts')) out.push(path)
  }
  return out
}

const files = [...new Set(roots.flatMap((r) => find(r)))].sort()
const flags = [
  '--experimental-strip-types',
  '--no-warnings=ExperimentalWarning',
  '--import', join(here, 'resolve-ts.mjs'),
  '--import', join(here, 'no-network.mjs'),
]

function run(file) {
  return new Promise((resolve) => {
    const started = Date.now()
    const child = spawn(process.execPath, [...flags, file], { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', (d) => (output += d))
    child.stderr.on('data', (d) => (output += d))
    child.on('close', (code) => resolve({ file, code, output, ms: Date.now() - started }))
  })
}

// a small pool: the checks are independent processes
const results = []
let next = 0
const workers = Array.from({ length: Math.min(cpus().length, 8, files.length) }, async () => {
  while (next < files.length) results.push(await run(files[next++]))
})
await Promise.all(workers)

results.sort((a, b) => a.file.localeCompare(b.file))
const failed = results.filter((r) => r.code !== 0)
for (const r of results) console.log(`${r.code === 0 ? 'ok  ' : 'FAIL'} ${relative(process.cwd(), r.file)} (${r.ms}ms)`)
for (const r of failed) console.log(`\n--- ${relative(process.cwd(), r.file)} ---\n${r.output.trim()}`)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
