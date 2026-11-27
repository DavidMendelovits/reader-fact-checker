// Self-check for the /api/fetch host guard and the client's retry classifier.
//
// The guard exists because /api/fetch is an unauthenticated proxy: without it,
// "paste an article URL" reaches localhost, the private ranges, and the cloud
// metadata endpoint from inside the deployment.
import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { blockedHost } from './_impl.ts'
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
