import type { VercelRequest, VercelResponse } from '@vercel/node'
// .js extension is required: package.json sets "type": "module", so these compile
// to ESM and Node resolves relative imports literally at runtime.
import { fetchArticle } from './_impl.js'

export const maxDuration = 30

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const url = typeof req.query.url === 'string' ? req.query.url : undefined
  if (!url) return res.status(400).json({ error: 'url param required' })
  try {
    const { html, finalUrl } = await fetchArticle(url)
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.setHeader('X-Final-Url', finalUrl)
    res.send(html)
  } catch (e) {
    res.status(502).json({ error: e instanceof Error ? e.message : String(e) })
  }
}
