import type { VercelRequest, VercelResponse } from '@vercel/node'
import { navigate, type NavigateRequest } from './_impl.js'

export const maxDuration = 10

/**
 * One fast typed decision about what the reader just said — which document,
 * chapter or shelf they mean — so the client can act without a conversation
 * turn. `{ enabled: false }` when no decider is configured; the client then
 * goes to the conversation as it always did.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).end()
  try {
    const decision = await navigate(req.body as NavigateRequest)
    res.status(200).json(decision ? { enabled: true, decision } : { enabled: false })
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) })
  }
}
