// The Deepgram Flux grant: what the server asks Deepgram for, what it hands the
// browser, when providers() offers it, and the route in front of it. A stubbed
// fetch stands in for Deepgram; no request leaves the process.
import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it, vi } from 'vitest'
import { deepgramListen } from './deepgram-listen.ts'
import { override, providers } from '../providers.ts'
import { resetLimits } from '../guard.ts'
import listenRoute from '../../listen.ts'

describe('deepgramListen', () => {
  it('trades the key for a token and says where to stream 16 kHz PCM', async () => {
    const seen: { url: string; init: RequestInit }[] = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      seen.push({ url, init })
      return Response.json({ access_token: 'jwt', expires_in: 60 })
    })
    const grant = await deepgramListen({ apiKey: 'k' }).grant()
    assert.equal(seen[0].url, 'https://api.deepgram.com/v1/auth/grant')
    assert.equal((seen[0].init.headers as Record<string, string>).Authorization, 'Token k')
    assert.deepEqual(JSON.parse(String(seen[0].init.body)), { ttl_seconds: 60 })
    assert.deepEqual(grant, {
      url: 'wss://api.deepgram.com/v2/listen?model=flux-general-en&encoding=linear16&sample_rate=16000',
      protocols: ['bearer', 'jwt'],
      expiresIn: 60,
    })
    assert.ok(!JSON.stringify(grant).includes('"k"'), 'the key itself never goes to the browser')
  })

  it('reads the key and model from env on each call', async () => {
    const auth: string[] = []
    vi.stubGlobal('fetch', async (_u: string, init: RequestInit) => {
      auth.push((init.headers as Record<string, string>).Authorization)
      return Response.json({ access_token: 't' })
    })
    const r = deepgramListen({})
    vi.stubEnv('DEEPGRAM_API_KEY', ' k1\n')
    vi.stubEnv('DEEPGRAM_MODEL', 'flux-general-multi')
    const g = await r.grant()
    assert.deepEqual(auth, ['Token k1'])
    assert.match(g.url, /model=flux-general-multi/)
    assert.equal(g.expiresIn, 30, 'Deepgram\'s default when it says nothing')
  })

  it('says the key is missing, and passes on what Deepgram said', async () => {
    vi.stubEnv('DEEPGRAM_API_KEY', '')
    await assert.rejects(deepgramListen({}).grant(), /DEEPGRAM_API_KEY/)
    vi.stubGlobal('fetch', async () => new Response('insufficient permissions', { status: 403 }))
    await assert.rejects(deepgramListen({ apiKey: 'k' }).grant(), /Deepgram grant failed \(403\): insufficient permissions/)
    vi.stubGlobal('fetch', async () => Response.json({}))
    await assert.rejects(deepgramListen({ apiKey: 'k' }).grant(), /no token/)
  })
})

describe('the listen provider', () => {
  it('is Deepgram once its key is set, nothing without it, and LISTEN_PROVIDER=none wins', () => {
    vi.stubEnv('DEEPGRAM_API_KEY', '')
    assert.equal(providers().listen, null)
    vi.stubEnv('DEEPGRAM_API_KEY', 'k')
    assert.equal(providers().listen?.name, 'deepgram')
    vi.stubEnv('LISTEN_PROVIDER', 'none')
    assert.equal(providers().listen, null)
  })
})

/** Just enough of VercelResponse to see what the route sends. */
function response() {
  const out = { status: 0, headers: {} as Record<string, string>, body: undefined as unknown }
  const res = {
    setHeader: (k: string, v: string) => ((out.headers[k.toLowerCase()] = v), res),
    status: (code: number) => ((out.status = code), res),
    json: (body: unknown) => ((out.body = body), res),
    end: () => res,
  }
  return { out, res }
}

describe('/api/listen', () => {
  beforeEach(() => resetLimits())
  afterEach(() => override('listen', null))
  const call = async (headers: Record<string, string> = {}) => {
    const { out, res } = response()
    await listenRoute({ method: 'POST', headers, body: undefined } as never, res as never)
    return out
  }

  it('answers 501 when no vendor is configured, so the browser keeps its own recognizer', async () => {
    vi.stubEnv('DEEPGRAM_API_KEY', '')
    const out = await call()
    assert.equal(out.status, 501)
  })

  it('hands out the grant, uncached', async () => {
    override('listen', { name: 'mock', grant: async () => ({ url: 'wss://x', protocols: ['bearer', 't'], expiresIn: 60 }) })
    const out = await call()
    assert.equal(out.status, 200)
    assert.equal(out.headers['cache-control'], 'no-store')
    assert.deepEqual(out.body, { url: 'wss://x', protocols: ['bearer', 't'], expiresIn: 60 })
  })

  it('asks for the access code before it spends anything', async () => {
    vi.stubEnv('APP_TOKEN', 'code')
    const grant = vi.fn()
    override('listen', { name: 'mock', grant })
    const out = await call()
    assert.equal(out.status, 401)
    assert.equal(grant.mock.calls.length, 0)
  })
})
