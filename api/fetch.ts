import type { VercelRequest, VercelResponse } from '@vercel/node'
// .js extension is required: package.json sets "type": "module", so these compile
// to ESM and Node resolves relative imports literally at runtime.
import { fetchArticle, gate } from './_impl.js'

export const maxDuration = 30

// The page comes back inside JSON, never as text/html: served as HTML from this
// origin, it would run its own scripts here and could read the web app's storage.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'")
  const url = typeof req.query.url === 'string' ? req.query.url : undefined
  if (!url) return res.status(400).json({ error: 'url param required' })
  if (!gate('fetch', req, res, url.length)) return
  try {
    res.status(200).json(await fetchArticle(url))
  } catch (e) {
    res.status(502).json({ error: e instanceof Error ? e.message : String(e) })
  }
}
