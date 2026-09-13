import type { VercelRequest, VercelResponse } from '@vercel/node'
// .js extension is required: package.json sets "type": "module", so these compile
// to ESM and Node resolves relative imports literally at runtime.
import { agentTurn, type AgentContext, type ClientExtras } from './_impl.js'

export const maxDuration = 120

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).end()
  try {
    const { messages, context, clientTools, clientSystem } = req.body as {
      messages: Parameters<typeof agentTurn>[0]
      context: AgentContext
      clientTools?: ClientExtras['tools']
      clientSystem?: ClientExtras['system']
    }
    res.status(200).json(await agentTurn(messages, context, undefined, undefined, { tools: clientTools, system: clientSystem }))
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) })
  }
}
