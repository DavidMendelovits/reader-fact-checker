// Fetch wrapper for our server endpoints. API keys live server-side; these routes
// are unauthenticated for now.
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
    throw new Error(`${path} failed (${res.status}): ${detail.slice(0, 300)}`)
  }
  return res.json() as Promise<T>
}
