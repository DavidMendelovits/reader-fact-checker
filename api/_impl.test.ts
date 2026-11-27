// Self-check for the /api/fetch host guard and the client's retry classifier.
//
// The guard exists because /api/fetch is an unauthenticated proxy: without it,
// "paste an article URL" reaches localhost, the private ranges, and the cloud
// metadata endpoint from inside the deployment.
import assert from 'node:assert/strict'
import { describe, it, vi } from 'vitest'
import { blockedHost, fetchArticle } from './_impl.ts'
import fetchRoute from './fetch.ts'
import { ApiError, isTransient } from '../src/lib/api.ts'

describe('blockedHost', () => {
  it('blocks localhost, private ranges and the cloud metadata endpoint', () => {
    for (const host of [
      'localhost',
      'LOCALHOST',
      'localhost.', // trailing dot resolves the same
      'foo.localhost',
      'metadata.internal',
      'printer.local',
      '127.0.0.1',
      '127.9.9.9',
      '0.0.0.0',
      '10.1.2.3',
      '100.100.0.1', // CGNAT
      '169.254.169.254', // cloud metadata
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '::1',
      '::',
      'fe80::1',
      'fd00::2',
    ]) {
      assert.equal(blockedHost(host), true, `should be blocked: ${host}`)
    }
  })

  it('lets public hosts through, including ones just outside the blocked ranges', () => {
    for (const host of [
      'en.wikipedia.org',
      'example.com',
      '93.184.216.34', // public IPv4
      '172.15.0.1', // just outside 172.16/12
      '172.32.0.1',
      '100.63.0.1', // just outside CGNAT
      '11.0.0.1',
      'localhost.example.com', // only the label "localhost" itself is special
    ]) {
      assert.equal(blockedHost(host), false, `should be fetchable: ${host}`)
    }
  })

  // The route passes URL#hostname, which keeps an IPv6 literal's brackets and
  // rewrites odd IPv4 spellings: test through the same path.
  const hostOf = (url: string) => blockedHost(new URL(url).hostname)

  it('blocks IPv6 loopback, private and link-local literals as URL#hostname gives them', () => {
    for (const url of [
      'http://[::1]/',
      'http://[::]/',
      'http://[fd00::2]/',
      'http://[FC00::1]/',
      'http://[fe80::1]/',
      'http://[febf::1]/', // still inside fe80::/10
      'http://[fec0::1]/', // site-local
      'http://[ff02::1]/', // multicast
      'http://[0:0:0:0:0:0:0:1]/',
    ]) {
      assert.equal(hostOf(url), true, `should be blocked: ${url}`)
    }
  })

  it('blocks private IPv4 hidden inside IPv6 and in odd IPv4 spellings', () => {
    for (const url of [
      'http://[::ffff:127.0.0.1]/', // IPv4-mapped, which Node writes as [::ffff:7f00:1]
      'http://[::ffff:169.254.169.254]/',
      'http://[::ffff:a00:1]/', // 10.0.0.1
      'http://[::127.0.0.1]/', // IPv4-compatible
      'http://[64:ff9b::7f00:1]/', // NAT64 of 127.0.0.1
      'http://2130706433/', // 127.0.0.1 as one number
      'http://0x7f.1/',
      'http://0177.0.0.1/',
      'http://224.0.0.1/', // multicast
    ]) {
      assert.equal(hostOf(url), true, `should be blocked: ${url}`)
    }
  })

  it('lets public IPv6 through, mapped public IPv4 included', () => {
    for (const url of [
      'http://[2606:4700:4700::1111]/',
      'http://[2001:db8::1]/',
      'http://[::ffff:93.184.216.34]/',
      'http://[64:ff9b::5db8:d822]/', // NAT64 of 93.184.216.34
      'http://[fe00::1]/', // just below fe80::/10
    ]) {
      assert.equal(hostOf(url), false, `should be fetchable: ${url}`)
    }
  })
})

describe('fetchArticle', () => {
  type Hop = { status: number; location?: string; body?: string }
  /** A stubbed fetch that answers each URL from a table and records every request it was sent. */
  function stub(table: Record<string, Hop>) {
    const sent: string[] = []
    vi.stubGlobal('fetch', async (input: URL | string, init?: RequestInit) => {
      const url = String(input)
      sent.push(url)
      assert.equal(init?.redirect, 'manual', 'redirects are followed by hand')
      const hop = table[url]
      if (!hop) throw new Error(`unexpected request to ${url}`)
      return new Response(hop.body ?? null, { status: hop.status, headers: hop.location ? { location: hop.location } : {} })
    })
    return sent
  }

  it('follows redirects, relative ones included, and reports where it landed', async () => {
    const sent = stub({
      'https://a.example/x': { status: 301, location: 'https://b.example/y' },
      'https://b.example/y': { status: 302, location: '/z' },
      'https://b.example/z': { status: 200, body: '<p>hi</p>' },
    })
    assert.deepEqual(await fetchArticle('https://a.example/x'), { html: '<p>hi</p>', finalUrl: 'https://b.example/z' })
    assert.deepEqual(sent, ['https://a.example/x', 'https://b.example/y', 'https://b.example/z'])
  })

  it('refuses a redirect to a private host before any request goes there', async () => {
    const sent = stub({ 'https://a.example/': { status: 302, location: 'http://169.254.169.254/latest/meta-data/' } })
    await assert.rejects(fetchArticle('https://a.example/'), /not fetchable/)
    assert.deepEqual(sent, ['https://a.example/'])
  })

  it('refuses a redirect to another scheme, an endless loop, and an error page', async () => {
    stub({ 'https://a.example/': { status: 302, location: 'file:///etc/passwd' } })
    await assert.rejects(fetchArticle('https://a.example/'), /invalid url/)
    stub({ 'https://a.example/': { status: 302, location: 'https://a.example/' } })
    await assert.rejects(fetchArticle('https://a.example/'), /too many redirects/)
    stub({ 'https://a.example/': { status: 404, body: 'nope' } })
    await assert.rejects(fetchArticle('https://a.example/'), /answered 404/)
  })

  it('refuses a private host up front', async () => {
    const sent = stub({})
    await assert.rejects(fetchArticle('http://[::ffff:127.0.0.1]:8080/'), /not fetchable/)
    assert.deepEqual(sent, [])
  })
})

describe('/api/fetch', () => {
  /** Just enough of VercelResponse to see what the route sends. */
  function response() {
    const out = { status: 0, headers: {} as Record<string, string>, body: undefined as unknown }
    const res = {
      setHeader: (k: string, v: string) => ((out.headers[k.toLowerCase()] = v), res),
      status: (code: number) => ((out.status = code), res),
      json: (body: unknown) => ((out.headers['content-type'] = 'application/json'), (out.body = body), res),
    }
    return { out, res }
  }

  it('answers in JSON with nosniff and a sandbox CSP, never as HTML from this origin', async () => {
    vi.stubGlobal('fetch', async () => new Response('<script>alert(1)</script>', { status: 200 }))
    const { out, res } = response()
    await fetchRoute({ query: { url: 'https://a.example/' } } as never, res as never)
    assert.equal(out.status, 200)
    assert.equal(out.headers['content-type'], 'application/json')
    assert.equal(out.headers['x-content-type-options'], 'nosniff')
    assert.match(out.headers['content-security-policy'], /sandbox/)
    assert.deepEqual(out.body, { html: '<script>alert(1)</script>', finalUrl: 'https://a.example/' })
  })
})

// transient = retry; anything else fails the same way twice
describe('isTransient', () => {
  it('retries overload, rate limits, server errors and requests that never left', () => {
    assert.equal(isTransient(new ApiError('overloaded', 529)), true)
    assert.equal(isTransient(new ApiError('rate limited', 429)), true)
    assert.equal(isTransient(new ApiError('server error', 500)), true)
    assert.equal(isTransient(new TypeError('fetch failed')), true) // request never left
  })

  it('does not retry anything that would fail the same way twice', () => {
    assert.equal(isTransient(new ApiError('bad request', 400)), false)
    assert.equal(isTransient(new ApiError('not found', 404)), false)
    assert.equal(isTransient(new Error('anything else')), false)
  })
})
