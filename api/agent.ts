import type { VercelRequest, VercelResponse } from '@vercel/node'
// .js extension is required: package.json sets "type": "module", so these compile
// to ESM and Node resolves relative imports literally at runtime.
import { agentTurn, type AgentContext } from './_impl.js'

export const maxDuration = 120

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).end()
  try {
    const { messages, context } = req.body as { messages: Parameters<typeof agentTurn>[0]; context: AgentContext }
    res.status(200).json(await agentTurn(messages, context))
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) })
  }
}
