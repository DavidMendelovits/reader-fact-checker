// Fetch wrapper for our server endpoints. API keys live server-side; these routes
// are unauthenticated for now.
export function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(path, init)
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
    throw new Error(`${path} failed (${res.status}): ${detail.slice(0, 300)}`)
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
    throw new Error(`${path} failed (${res.status}): ${detail.slice(0, 300)}`)
  }
  return res.json() as Promise<T>
}
