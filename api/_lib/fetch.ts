// Article import needs an HTML proxy to dodge CORS. Not a provider — there is
// nothing to swap — so it lives here rather than behind a port.

/** A private, loopback, link-local or CGNAT IPv4 address, as four numbers. */
function blockedV4(a: number, b: number): boolean {
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT — where some cloud metadata services live
    (a === 169 && b === 254) || // link-local, 169.254.169.254 metadata included
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224 // multicast and reserved
  )
}

/** An IPv6 literal as eight 16-bit groups, or null when it isn't one. Node's URL has already normalised it. */
function v6Groups(h: string): number[] | null {
  if (!h.includes(':')) return null
  let s = h
  const dotted = s.match(/^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/) // a trailing dotted IPv4 is two groups
  if (dotted) {
    const [a, b, c, d] = dotted.slice(2).map(Number)
    s = `${dotted[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const halves = s.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const missing = 8 - head.length - tail.length
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail].map((g) => parseInt(g, 16))
  return groups.length === 8 && groups.every((g) => g >= 0 && g <= 0xffff) ? groups : null
}

function blockedV6(g: number[]): boolean {
  const zeros = (n: number) => g.slice(0, n).every((x) => x === 0)
  const embedded = () => blockedV4(g[6] >> 8, g[6] & 0xff)
  if (zeros(8)) return true // ::
  if (zeros(7) && g[7] === 1) return true // ::1
  if (zeros(5) && g[5] === 0xffff) return embedded() // ::ffff:a.b.c.d, IPv4-mapped
  if (zeros(6)) return true // ::a.b.c.d, IPv4-compatible (deprecated): never a real public host
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return embedded() // NAT64
  return (
    (g[0] & 0xfe00) === 0xfc00 || // fc00::/7 unique local
    (g[0] & 0xffc0) === 0xfe80 || // fe80::/10 link-local
    (g[0] & 0xffc0) === 0xfec0 || // fec0::/10 site-local (deprecated)
    (g[0] & 0xff00) === 0xff00 // multicast
  )
}

/**
 * /api/fetch fetches whatever URL it's handed. Without this it reaches
 * localhost, the private ranges, and cloud metadata from inside the deployment.
 * Takes URL#hostname, which keeps the brackets on an IPv6 literal and has
 * already turned 2130706433 or 0x7f.1 into 127.0.0.1.
 *
 * ponytail: hostname-level checks only. A name that resolves to a private
 * address (DNS rebinding) gets through; pinning the resolved address needs a
 * custom dispatcher, which an article reader doesn't earn yet.
 */
export function blockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true
  const v4 = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
  if (v4) return blockedV4(Number(v4[1]), Number(v4[2]))
  const v6 = v6Groups(h)
  if (v6) return blockedV6(v6)
  return h.includes(':') // an IPv6-looking host we couldn't parse: refuse rather than guess
}

const MAX_ARTICLE_BYTES = 5_000_000
const MAX_REDIRECTS = 5

/** Parse and vet one URL: http(s) only, and never a private host. */
function vetted(url: string, base?: string): URL {
  let parsed: URL
  try {
    parsed = new URL(url, base)
  } catch {
    throw new Error('invalid url')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('invalid url')
  if (blockedHost(parsed.hostname)) throw new Error('that host is not fetchable')
  return parsed
}

export async function fetchArticle(url: string): Promise<{ html: string; finalUrl: string }> {
  let target = vetted(url)
  const signal = AbortSignal.timeout(20_000) // the whole chain, under the route's 30 s limit
  // Follow redirects by hand, so each hop is vetted before a request goes to it.
  for (let hop = 0; ; hop++) {
    const upstream = await fetch(target, {
      headers: { 'User-Agent': 'Mozilla/5.0 (reader-fact-checker POC)' },
      redirect: 'manual',
      signal, // a hung origin must not hold the function open
    })
    const location = upstream.headers.get('location')
    if (upstream.status >= 300 && upstream.status < 400 && location) {
      await upstream.body?.cancel()
      if (hop >= MAX_REDIRECTS) throw new Error('too many redirects')
      target = vetted(location, target.href)
      continue
    }
    if (!upstream.ok) throw new Error(`the page answered ${upstream.status}`)
    const length = Number(upstream.headers.get('content-length'))
    if (length > MAX_ARTICLE_BYTES) throw new Error('page too large to import')
    const html = await upstream.text()
    if (html.length > MAX_ARTICLE_BYTES) throw new Error('page too large to import')
    return { html, finalUrl: target.href }
  }
}
