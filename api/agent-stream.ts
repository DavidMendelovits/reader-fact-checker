import type { VercelRequest, VercelResponse } from '@vercel/node'
// .js extension is required: package.json sets "type": "module", so these compile
// to ESM and Node resolves relative imports literally at runtime.
import { agentNdjson, type AgentContext, type ClientExtras } from './_impl.js'

export const maxDuration = 120

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).end()
  try {
    const { messages, context, clientTools, clientSystem } = req.body as {
      messages: Parameters<typeof agentNdjson>[0]
      context: AgentContext
      clientTools?: ClientExtras['tools']
      clientSystem?: ClientExtras['system']
    }
    if (!Array.isArray(messages) || messages.length === 0) return res.status(400).json({ error: 'messages required' })
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache, no-transform' })
    await agentNdjson(messages, context, (line) => res.write(line), { tools: clientTools, system: clientSystem })
    res.end()
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) })
  }
}
