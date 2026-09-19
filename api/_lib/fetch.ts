// Article import needs an HTML proxy to dodge CORS. Not a provider — there is
// nothing to swap — so it lives here rather than behind a port.

/**
 * /api/fetch is an unauthenticated proxy that fetches whatever URL it's handed —
 * without this it reaches localhost, the private ranges, and cloud metadata from
 * inside the deployment. Hostname-level checks; a DNS-rebinding-proof version
 * needs to resolve and pin the address, which a POC article reader doesn't earn.
 */
export function blockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '')
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true
  const v4 = h.match(/^(\d+)\.(\d+)\.\d+\.\d+$/)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) || // CGNAT — where some cloud metadata services live
      (a === 169 && b === 254) || // link-local, 169.254.169.254 metadata included
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    )
  }
  // URL#hostname strips the brackets off an IPv6 literal
  return h === '::' || h === '::1' || h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')
}

const MAX_ARTICLE_BYTES = 5_000_000

export async function fetchArticle(url: string): Promise<{ html: string; finalUrl: string }> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('invalid url')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('invalid url')
  if (blockedHost(parsed.hostname)) throw new Error('that host is not fetchable')
  const upstream = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (reader-fact-checker POC)' },
    redirect: 'follow',
    signal: AbortSignal.timeout(20_000), // a hung origin must not hold the function open
  })
  // redirects can land somewhere the original hostname check never saw
  if (blockedHost(new URL(upstream.url).hostname)) throw new Error('that host is not fetchable')
  const length = Number(upstream.headers.get('content-length'))
  if (length > MAX_ARTICLE_BYTES) throw new Error('page too large to import')
  const html = await upstream.text()
  if (html.length > MAX_ARTICLE_BYTES) throw new Error('page too large to import')
  return { html, finalUrl: upstream.url }
}
