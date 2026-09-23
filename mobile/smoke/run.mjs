// `npm run smoke:web`: export the web build pointed at the fake backend, serve
// both, run web.mjs, tear down. Needs a Chromium: Playwright's, or any Chrome
// via SMOKE_CHROME. Nothing here touches Readwise or any model.
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const dist = join(root, 'dist-smoke')
// Overridable: a dev server (`expo start --port 8082`) may already own the
// default, and the test does not care which port it runs on.
const BACKEND = Number(process.env.SMOKE_BACKEND_PORT || 5300)
const APP = Number(process.env.SMOKE_PORT || 8082)

const env = {
  ...process.env,
  CI: '1',
  EXPO_OFFLINE: '1',
  EXPO_NO_TELEMETRY: '1',
  EXPO_NO_DEPENDENCY_VALIDATION: '1',
  EXPO_PUBLIC_SILENT_VOICE: '1',
  EXPO_PUBLIC_READWISE_BASE: `http://localhost:${BACKEND}`,
  EXPO_PUBLIC_API_BASE: `http://localhost:${BACKEND}`,
}

console.log('exporting the web build…')
const exp = spawnSync('npx', ['expo', 'export', '--platform', 'web', '--clear', '--output-dir', dist], { cwd: root, env, stdio: 'inherit' })
if (exp.status !== 0) process.exit(exp.status ?? 1)

const backend = spawn(process.execPath, [join(root, 'smoke', 'fake-backend.mjs')], { env: { ...process.env, PORT: String(BACKEND) }, stdio: ['ignore', 'ignore', 'inherit'] })

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.ico': 'image/x-icon', '.png': 'image/png' }
const web = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname)
  let file = join(dist, path === '/' ? 'index.html' : path)
  try {
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html')
    res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream' })
    res.end(await readFile(file))
  } catch {
    res.writeHead(404).end()
  }
})
web.on('error', (e) => {
  console.error(`could not serve the app on :${APP}: ${e.message}`)
  backend.kill()
  process.exit(1)
})
web.listen(APP)

// both servers answering before the browser goes anywhere near them
const ready = async (url, headers = {}) => {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(url, { headers })
      if (r.ok) return
    } catch {}
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`${url} never answered`)
}
await ready(`http://localhost:${APP}/`)
await ready(`http://localhost:${BACKEND}/api/v3/list/?location=new`, { Authorization: 'Token probe' })

// spawn, not spawnSync: the static server above lives in this process and has
// to keep answering while the test runs
const status = await new Promise((resolve) => {
  const test = spawn(process.execPath, [join(root, 'smoke', 'web.mjs')], { env: { ...process.env, SMOKE_APP_URL: `http://localhost:${APP}`, SMOKE_BACKEND_URL: `http://localhost:${BACKEND}` }, stdio: 'inherit' })
  test.on('exit', (code) => resolve(code ?? 1))
})

backend.kill()
web.close()
process.exit(status)
