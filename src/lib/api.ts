// Fetch wrapper for our server endpoints. API keys live server-side; these routes
// are unauthenticated for now.
export class ApiError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

/**
 * Worth one more try: the request never reached the server (fetch rejects with a
 * TypeError), or the server said "not right now" — rate limit, overload, or a 5xx
 * that a fresh attempt routinely clears. A 4xx other than 429 is our bug and will
 * fail identically every time.
 */
export const isTransient = (e: unknown): boolean =>
  e instanceof ApiError ? e.status === 429 || e.status >= 500 : e instanceof TypeError

export function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(path, init)
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
const RETRY_WAITS = [1000, 2500]

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
