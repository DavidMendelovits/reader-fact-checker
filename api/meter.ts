import type { VercelRequest, VercelResponse } from '@vercel/node'
import { bodyChars, gate, recordClientEvents } from './_impl.js'

export const maxDuration = 10

/** The browser's own timings (barge-in, first audio, speech-input seconds), logged as [meter] lines. */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).end()
  if (!gate('meter', req, res, bodyChars(req.body))) return
  const problem = recordClientEvents(req.body)
  if (problem) return res.status(problem.status).json({ error: problem.error })
  res.status(204).end()
}
