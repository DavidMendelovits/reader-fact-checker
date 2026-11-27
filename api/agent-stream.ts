import type { VercelRequest, VercelResponse } from '@vercel/node'
// .js extension is required: package.json sets "type": "module", so these compile
// to ESM and Node resolves relative imports literally at runtime.
import { agentNdjson, agentRequestProblem, bodyChars, clientOf, gate, type AgentContext } from './_impl.js'

export const maxDuration = 120

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).end()
  if (!gate('agent', req, res, bodyChars(req.body))) return
  const problem = agentRequestProblem(req.body)
  if (problem) return res.status(problem.status).json({ error: problem.error })
  try {
    const { messages, context } = req.body as {
      messages: Parameters<typeof agentNdjson>[0]
      context: AgentContext
    }
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache, no-transform' })
    await agentNdjson(messages, context, (line) => res.write(line), clientOf(req.body))
    res.end()
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) })
  }
}
