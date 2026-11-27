// The door every /api route goes through before it spends anything: an
// optional access code, a per-address rate limit, and a cap on how much a
// request may carry. The routes call the model, search and speech vendors with
// this deployment's keys, so without this anyone with the URL spends them.
//
//   APP_TOKEN  when set, every request must carry it as `x-app-token`. Unset,
//              the routes stay open (the spend limit on each key is then the
//              only cap), so turning it on is the deployer's call.

import { timingSafeEqual } from 'node:crypto'

export type Route = 'agent' | 'factcheck' | 'claims' | 'tts' | 'fetch' | 'navigate' | 'library'

/** Requests a minute from one address, and the most a request body may hold, in characters. */
export const LIMITS: Record<Route, { perMinute: number; maxChars: number }> = {
  agent: { perMinute: 60, maxChars: 400_000 }, // a trimmed conversation plus the nearby text
  factcheck: { perMinute: 60, maxChars: 100_000 }, // the whole-document scan runs three at a time
  claims: { perMinute: 60, maxChars: 80_000 }, // one ~2,000-word section
  tts: { perMinute: 180, maxChars: 16_000 }, // one paragraph; speech.ts cuts the text at 12k itself
  fetch: { perMinute: 30, maxChars: 4_000 }, // the URL
  navigate: { perMinute: 240, maxChars: 100_000 }, // asked on partial transcripts; carries every chapter title
  library: { perMinute: 120, maxChars: 100_000 },
}

export interface Refusal {
  status: 401 | 413 | 429
  error: string
  retryAfter?: number
}

type Headers = Record<string, string | string[] | undefined>
const header = (h: Headers, name: string) => {
  const v = h[name]
  return Array.isArray(v) ? v[0] : v
}

function tokenOk(given: string | undefined): boolean {
  const want = process.env.APP_TOKEN
  if (!want) return true
  if (!given) return false
  const a = Buffer.from(given)
  const b = Buffer.from(want)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** The caller's address as the platform reports it: Vercel sets x-real-ip and puts the client first in x-forwarded-for. */
export function callerOf(h: Headers, fallback = 'unknown'): string {
  return header(h, 'x-real-ip') ?? header(h, 'x-forwarded-for')?.split(',')[0]?.trim() ?? fallback
}

// ponytail: counts live in this function instance's memory, so each instance
// keeps its own and a cold start forgets them. It stops one address hammering
// a warm instance, not a determined spender: APP_TOKEN is the real lock, and a
// shared store (Redis, Vercel's firewall rules) is the upgrade.
const windows = new Map<string, { start: number; count: number }>()
const WINDOW_MS = 60_000

function overLimit(route: Route, caller: string, now: number): number | null {
  const key = `${route} ${caller}`
  const w = windows.get(key)
  if (!w || now - w.start >= WINDOW_MS) {
    if (windows.size > 10_000) windows.clear() // never grow without bound
    windows.set(key, { start: now, count: 1 })
    return null
  }
  w.count++
  return w.count > LIMITS[route].perMinute ? Math.ceil((w.start + WINDOW_MS - now) / 1000) : null
}

/**
 * Whether a request may go on. `chars` is the size of what it carries (the body,
 * or the URL for /api/fetch). Null means yes; otherwise what to answer.
 */
export function admit(route: Route, h: Headers, chars: number, caller = callerOf(h), now = Date.now()): Refusal | null {
  // counted before the code is checked, so wrong guesses use up the quota too
  const retryAfter = overLimit(route, caller, now)
  if (retryAfter != null) return { status: 429, error: 'too many requests, wait a minute', retryAfter }
  if (!tokenOk(header(h, 'x-app-token'))) return { status: 401, error: 'app token required' }
  if (chars > LIMITS[route].maxChars) return { status: 413, error: 'request too large' }
  return null
}

/** Headers that go with a refusal: when to come back, or that the access code is what's missing. */
export function refusalHeaders(no: Refusal): Record<string, string> {
  if (no.status === 401) return { 'WWW-Authenticate': 'AppToken' }
  return no.retryAfter ? { 'Retry-After': String(no.retryAfter) } : {}
}

/** For tests: forget every count. */
export function resetLimits() {
  windows.clear()
}

interface Res {
  setHeader(name: string, value: string): unknown
  status(code: number): { json(body: unknown): unknown }
}

/**
 * The Vercel routes' one line: true when the request may go on, otherwise the
 * refusal has been sent.
 */
export function gate(route: Route, req: { headers: Headers }, res: Res, chars: number): boolean {
  const no = admit(route, req.headers, chars)
  if (!no) return true
  for (const [k, v] of Object.entries(refusalHeaders(no))) res.setHeader(k, v)
  res.status(no.status).json({ error: no.error })
  return false
}

/** How many characters a parsed JSON body holds, as it came over the wire. */
export const bodyChars = (body: unknown) => (body == null ? 0 : typeof body === 'string' ? body.length : JSON.stringify(body).length)
