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

      server.middlewares.use('/api/fetch', async (req, res) => {
        const url = new URL(req.url ?? '', 'http://localhost').searchParams.get('url')
        if (!url) return json(res, 400, { error: 'url param required' })
        try {
          const { html, finalUrl } = await impl.fetchArticle(url)
          res.setHeader('Content-Type', 'text/html; charset=utf-8')
          res.setHeader('X-Final-Url', finalUrl)
          res.end(html)
        } catch (e) {
          json(res, 502, { error: e instanceof Error ? e.message : String(e) })
        }
      })

      server.middlewares.use('/api/factcheck', async (req, res) => {
        try {
          const { messages } = JSON.parse(await readBody(req))
          res.statusCode = 200
          res.setHeader('Content-Type', 'application/x-ndjson')
          res.setHeader('Cache-Control', 'no-cache, no-transform')
          await impl.factcheckNdjson(messages, (line) => res.write(line))
          res.end()
        } catch (e) {
          json(res, 500, { error: e instanceof Error ? e.message : String(e) })
        }
      })

      server.middlewares.use('/api/agent', async (req, res) => {
        try {
          const { messages, context } = JSON.parse(await readBody(req))
          json(res, 200, await impl.agentTurn(messages, context))
        } catch (e) {
          json(res, 500, { error: e instanceof Error ? e.message : String(e) })
        }
      })

      server.middlewares.use('/api/claims', async (req, res) => {
        try {
          const { section } = JSON.parse(await readBody(req))
          json(res, 200, { claims: await impl.extractClaims(section) })
        } catch (e) {
          json(res, 500, { error: e instanceof Error ? e.message : String(e) })
        }
      })

      server.middlewares.use('/api/tts', async (req, res) => {
        try {
          const { text } = JSON.parse(await readBody(req))
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
