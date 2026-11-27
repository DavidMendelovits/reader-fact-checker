// Fetch wrapper for our server endpoints. API keys live server-side. When the
// deployer sets an access code (APP_TOKEN on the server), every request carries
// it; the first refusal asks the reader for it once and keeps it in this browser.
export class ApiError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

/**
 * Worth one more try: the request never reached the server (fetch rejects with a
 * TypeError), or a 5xx that a fresh attempt routinely clears (a vendor's overload
 * or rate limit arrives as one). A 4xx is final: a 429 is this server's own
 * per-minute limit, which a retry a second later only counts against again.
 */
export const isTransient = (e: unknown): boolean =>
  e instanceof ApiError ? e.status >= 500 : e instanceof TypeError

const APP_TOKEN_KEY = 'rfc-app-token'

function storedCode(): string | null {
  try {
    return localStorage.getItem(APP_TOKEN_KEY)
  } catch {
    return null
  }
}

const withCode = (init: RequestInit, code: string | null): RequestInit =>
  code ? { ...init, headers: { ...(init.headers as Record<string, string> | undefined), 'x-app-token': code } } : init

// Several requests can be refused at once (the whole-document scan runs three);
// they all wait on one question.
let asking: Promise<string | null> | null = null

function askForCode(): Promise<string | null> {
  asking ??= Promise.resolve()
    .then(() => {
      // ponytail: the browser's own prompt is the whole sign-in screen; a real one
      // can come when there are accounts
      const code = window.prompt('This reader needs its access code.')?.trim() || null
      try {
        if (code) localStorage.setItem(APP_TOKEN_KEY, code)
        else localStorage.removeItem(APP_TOKEN_KEY) // cancelled: forget a code that no longer works
      } catch {
        // storage blocked: the code still works for this request
      }
      return code
    })
    .finally(() => (asking = null))
  return asking
}

export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const sent = storedCode()
  const res = await fetch(path, withCode(init, sent))
  // only the server's own access-code refusal, not a 401 passed on from Readwise
  if (res.status !== 401 || res.headers.get('www-authenticate') !== 'AppToken' || typeof window === 'undefined') return res
  // another request may have been asked already and stored the code since
  const code = storedCode() !== sent ? storedCode() : await askForCode()
  return code ? fetch(path, withCode(init, code)) : res
}

/**
 * POST to a route that answers in newline-delimited JSON, handing each parsed line
 * to `onLine` as it lands. Resolves when the stream closes.
 */
export async function apiNdjson<T>(path: string, body: unknown, onLine: (msg: T) => void): Promise<void> {
  const res = await apiFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new ApiError(`${path} failed (${res.status}): ${detail.slice(0, 300)}`, res.status)
  }
  if (!res.body) throw new Error(`${path} returned no body`)
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? '' // trailing partial line
    for (const line of lines) {
      if (line.trim()) onLine(JSON.parse(line) as T)
    }
  }
}

export async function apiJson<T>(path: string, body: unknown): Promise<T> {
  const res = await apiFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new ApiError(`${path} failed (${res.status}): ${detail.slice(0, 300)}`, res.status)
  }
  return res.json() as Promise<T>
}

// ponytail: fixed two-retry schedule; make it a parameter when a second caller wants one
export const RETRY_WAITS = [1000, 2500]

/**
 * apiJson with retries on transient failures. A voice turn dying to a single
 * network blip or 529 reads as the app going deaf mid-conversation; two spaced
 * retries cover the blip without hiding a real outage for more than a few seconds.
 */
export async function apiJsonRetry<T>(path: string, body: unknown): Promise<T> {
  for (const wait of RETRY_WAITS) {
    try {
      return await apiJson<T>(path, body)
    } catch (e) {
      if (!isTransient(e)) throw e
      await new Promise((r) => setTimeout(r, wait))
    }
  }
  return apiJson<T>(path, body)
}
