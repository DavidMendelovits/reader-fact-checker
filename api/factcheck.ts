import type { VercelRequest, VercelResponse } from '@vercel/node'
// .js extension is required: package.json sets "type": "module", so these compile
// to ESM and Node resolves relative imports literally at runtime.
import { factcheckNdjson, passageFromMessages } from './_impl.js'

export const maxDuration = 300 // web search turns can take a while

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).end()
  try {
    const body = req.body as { passage?: string; messages?: { role: string; content: string }[] }
    // older mobile builds still send a ready-made chat message; take the passage out of it
    const passage = typeof body.passage === 'string' ? body.passage.trim() : passageFromMessages(body.messages ?? [])
    if (!passage) return res.status(400).json({ error: 'passage required' })
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache, no-transform' })
    await factcheckNdjson(passage, (line) => res.write(line))
    res.end()
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) })
  }
}
