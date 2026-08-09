import type { VercelRequest, VercelResponse } from '@vercel/node'
// .js extension is required: package.json sets "type": "module", so these compile
// to ESM and Node resolves relative imports literally at runtime.
import { factcheckNdjson } from './_impl.js'

export const maxDuration = 300 // web search turns can take a while

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).end()
  try {
    const { messages } = req.body as { messages: Parameters<typeof factcheckNdjson>[0] }
    if (!Array.isArray(messages) || messages.length === 0) return res.status(400).json({ error: 'messages required' })
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache, no-transform' })
    await factcheckNdjson(messages, (line) => res.write(line))
    res.end()
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) })
  }
}
