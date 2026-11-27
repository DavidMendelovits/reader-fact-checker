import type { VercelRequest, VercelResponse } from '@vercel/node'
// .js extension is required: package.json sets "type": "module", so these compile
// to ESM and Node resolves relative imports literally at runtime.
import { LibraryError, libraryRequest } from './_impl.js'

export const maxDuration = 30

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).end()
  const token = req.headers['x-readwise-token']
  try {
    res.status(200).json(await libraryRequest(req.body, typeof token === 'string' ? token : null))
  } catch (e) {
    const status = e instanceof LibraryError ? e.status : 502
    res.status(status).json({ error: e instanceof Error ? e.message : String(e) })
  }
}
