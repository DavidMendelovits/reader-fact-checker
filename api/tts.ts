import type { VercelRequest, VercelResponse } from '@vercel/node'
// .js extension is required: package.json sets "type": "module", so these compile
// to ESM and Node resolves relative imports literally at runtime.
import { Readable } from 'node:stream'
import { ttsStream } from './_impl.js'

export const maxDuration = 60

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).end()
  try {
    const { text } = req.body as { text: string }
    if (typeof text !== 'string' || !text.trim()) return res.status(400).json({ error: 'text required' })
    const upstream = await ttsStream(text)
    res.setHeader('Content-Type', 'audio/mpeg')
    // pipe rather than buffer: the browser starts playing on the first chunk
    await new Promise<void>((resolve, reject) => {
      Readable.fromWeb(upstream.body as never).pipe(res).on('finish', resolve).on('error', reject)
    })
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) })
  }
}
