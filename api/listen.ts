import type { VercelRequest, VercelResponse } from '@vercel/node'
import { bodyChars, gate, listenGrant } from './_impl.js'

export const maxDuration = 10

/**
 * A short-lived grant to stream the mic to the speech-to-text vendor directly.
 * 501 when none is configured: the browser then keeps Chrome's recognizer.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).end()
  if (!gate('listen', req, res, bodyChars(req.body))) return
  res.setHeader('Cache-Control', 'no-store')
  try {
    const grant = await listenGrant()
    if (!grant) return res.status(501).json({ error: 'speech input not configured' })
    res.status(200).json(grant)
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) })
  }
}
