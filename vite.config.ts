import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'

// Dev-server mirror of the Vercel functions in api/ — same impl module, same routes,
// so `npm run dev` behaves like the deployed app. Keys stay in the Node process.
function apiRoutes(): Plugin {
  return {
    name: 'api-routes',
    async configureServer(server) {
      const impl = await import('./api/_impl')

      const readBody = (req: IncomingMessage) =>
        new Promise<string>((resolve, reject) => {
          let data = ''
          req.on('data', (c) => (data += c))
          req.on('end', () => resolve(data))
          req.on('error', reject)
        })

      const json = (res: ServerResponse, status: number, body: unknown) => {
        res.statusCode = status
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify(body))
      }

      // the same door as the deployed routes (api/_lib/guard.ts)
      const admitted = (route: Parameters<typeof impl.admit>[0], req: IncomingMessage, res: ServerResponse, chars: number) => {
        const no = impl.admit(route, req.headers, chars, req.socket.remoteAddress ?? 'local')
        if (!no) return true
        for (const [k, v] of Object.entries(impl.refusalHeaders(no))) res.setHeader(k, v)
        json(res, no.status, { error: no.error })
        return false
      }

      server.middlewares.use('/api/fetch', async (req, res) => {
        const url = new URL(req.url ?? '', 'http://localhost').searchParams.get('url')
        if (!url) return json(res, 400, { error: 'url param required' })
        if (!admitted('fetch', req, res, url.length)) return
        res.setHeader('X-Content-Type-Options', 'nosniff')
        try {
          json(res, 200, await impl.fetchArticle(url))
        } catch (e) {
          json(res, 502, { error: e instanceof Error ? e.message : String(e) })
        }
      })

      server.middlewares.use('/api/factcheck', async (req, res) => {
        try {
          const raw = await readBody(req)
          if (!admitted('factcheck', req, res, raw.length)) return
          const body = JSON.parse(raw)
          const passage = typeof body.passage === 'string' ? body.passage.trim() : impl.passageFromMessages(body.messages ?? [])
          if (!passage) return json(res, 400, { error: 'passage required' })
          res.statusCode = 200
          res.setHeader('Content-Type', 'application/x-ndjson')
          res.setHeader('Cache-Control', 'no-cache, no-transform')
          await impl.factcheckNdjson(passage, (line) => res.write(line))
          res.end()
        } catch (e) {
          json(res, 500, { error: e instanceof Error ? e.message : String(e) })
        }
      })

      server.middlewares.use('/api/agent-stream', async (req, res) => {
        try {
          const raw = await readBody(req)
          if (!admitted('agent', req, res, raw.length)) return
          const body = JSON.parse(raw)
          const problem = impl.agentRequestProblem(body)
          if (problem) return json(res, problem.status, { error: problem.error })
          res.statusCode = 200
          res.setHeader('Content-Type', 'application/x-ndjson')
          res.setHeader('Cache-Control', 'no-cache, no-transform')
          await impl.agentNdjson(body.messages, body.context, (line) => res.write(line), body.client)
          res.end()
        } catch (e) {
          json(res, 500, { error: e instanceof Error ? e.message : String(e) })
        }
      })

      server.middlewares.use('/api/agent', async (req, res) => {
        try {
          const raw = await readBody(req)
          if (!admitted('agent', req, res, raw.length)) return
          const body = JSON.parse(raw)
          const problem = impl.agentRequestProblem(body)
          if (problem) return json(res, problem.status, { error: problem.error })
          json(res, 200, await impl.agentTurn(body.messages, body.context, undefined, undefined, body.client))
        } catch (e) {
          json(res, 500, { error: e instanceof Error ? e.message : String(e) })
        }
      })

      server.middlewares.use('/api/library', async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { error: 'POST only' })
        const token = req.headers['x-readwise-token']
        let body: unknown
        try {
          const raw = await readBody(req)
          if (!admitted('library', req, res, raw.length)) return
          body = JSON.parse(raw)
        } catch {
          return json(res, 400, { error: 'JSON body required' })
        }
        try {
          json(res, 200, await impl.libraryRequest(body, typeof token === 'string' ? token : null))
        } catch (e) {
          json(res, e instanceof impl.LibraryError ? e.status : 502, { error: e instanceof Error ? e.message : String(e) })
        }
      })

      server.middlewares.use('/api/claims', async (req, res) => {
        try {
          const raw = await readBody(req)
          if (!admitted('claims', req, res, raw.length)) return
          const { section } = JSON.parse(raw)
          json(res, 200, { claims: await impl.extractClaims(section) })
        } catch (e) {
          json(res, 500, { error: e instanceof Error ? e.message : String(e) })
        }
      })

      server.middlewares.use('/api/navigate', async (req, res) => {
        try {
          const raw = await readBody(req)
          if (!admitted('navigate', req, res, raw.length)) return
          const decision = await impl.navigate(JSON.parse(raw))
          json(res, 200, decision ? { enabled: true, decision } : { enabled: false })
        } catch (e) {
          json(res, 500, { error: e instanceof Error ? e.message : String(e) })
        }
      })

      server.middlewares.use('/api/tts', async (req, res) => {
        try {
          const raw = await readBody(req)
          if (!admitted('tts', req, res, raw.length)) return
          const { text } = JSON.parse(raw)
          const upstream = await impl.ttsStream(text)
          res.setHeader('Content-Type', 'audio/mpeg')
          Readable.fromWeb(upstream.body as never).pipe(res)
        } catch (e) {
          json(res, 500, { error: e instanceof Error ? e.message : String(e) })
        }
      })
    },
  }
}

export default defineConfig(({ mode }) => {
  // expose .env.local values (ANTHROPIC_API_KEY etc.) to the dev-server process
  Object.assign(process.env, loadEnv(mode, process.cwd(), ''))
  return {
    plugins: [react(), apiRoutes()],
  }
})
