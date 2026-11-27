// The web's side of the access code (api.ts): sent with every request once
// known, asked for once when the server refuses for want of it, and never
// asked for when a 401 comes from somewhere else (Readwise, through /api/library).
import assert from 'node:assert/strict'
import { beforeEach, describe, it, vi } from 'vitest'
import { apiFetch } from './api.ts'

function storage() {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  }
}

const refusal = () => new Response('{"error":"app token required"}', { status: 401, headers: { 'WWW-Authenticate': 'AppToken' } })

/** A server that wants `code`, recording the code each request carried. */
function server(code: string) {
  const sent: (string | null)[] = []
  vi.stubGlobal('fetch', async (_path: string, init: RequestInit = {}) => {
    const given = (init.headers as Record<string, string> | undefined)?.['x-app-token'] ?? null
    sent.push(given)
    return given === code ? new Response('ok') : refusal()
  })
  return sent
}

beforeEach(() => {
  vi.stubGlobal('localStorage', storage())
  vi.stubGlobal('window', { prompt: vi.fn(() => null) })
})

describe('apiFetch and the access code', () => {
  it('asks once on the refusal, retries with the code, and sends it from then on', async () => {
    const sent = server('sesame')
    const prompt = vi.fn(() => ' sesame ')
    vi.stubGlobal('window', { prompt })
    const init = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }
    assert.equal(await (await apiFetch('/api/agent', init)).text(), 'ok')
    assert.equal(await (await apiFetch('/api/agent', init)).text(), 'ok')
    assert.deepEqual(sent, [null, 'sesame', 'sesame'])
    assert.equal(prompt.mock.calls.length, 1)
  })

  it('asks one question for requests refused together', async () => {
    const sent = server('sesame')
    const prompt = vi.fn(() => 'sesame')
    vi.stubGlobal('window', { prompt })
    const answers = await Promise.all([apiFetch('/a'), apiFetch('/b'), apiFetch('/c')])
    assert.deepEqual(answers.map((r) => r.status), [200, 200, 200])
    assert.equal(prompt.mock.calls.length, 1)
    assert.equal(sent.filter((s) => s === 'sesame').length, 3)
  })

  it('hands back the refusal when the reader cancels', async () => {
    server('sesame')
    const res = await apiFetch('/api/agent')
    assert.equal(res.status, 401)
  })

  it('leaves a 401 from anyone else alone', async () => {
    vi.stubGlobal('fetch', async () => new Response('Readwise rejected the token', { status: 401 }))
    const prompt = vi.fn(() => 'x')
    vi.stubGlobal('window', { prompt })
    assert.equal((await apiFetch('/api/library')).status, 401)
    assert.equal(prompt.mock.calls.length, 0)
  })

  it('sends no code when there is none', async () => {
    const sent: (string | null)[] = []
    vi.stubGlobal('fetch', async (_p: string, init: RequestInit = {}) => {
      sent.push((init.headers as Record<string, string> | undefined)?.['x-app-token'] ?? null)
      return new Response('ok')
    })
    await apiFetch('/api/tts', { method: 'POST' })
    assert.deepEqual(sent, [null])
  })
})
