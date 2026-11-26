// Loaded before every test file (vitest.config.ts): no test may reach a real API.
// Every TCP connection goes through net.Socket#connect, fetch and node:http
// included, so one check here covers them all. Loopback stays open for anything
// the test runner itself needs. A test that wants a vendor's answer mocks the
// port or stubs fetch with vi.stubGlobal.
import net from 'node:net'

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', undefined])
const connect = net.Socket.prototype.connect

net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
  const first = args[0]
  const opts = (Array.isArray(first) ? first[0] : first) as { host?: string; path?: string } | number | string
  const host = typeof opts === 'object' && opts ? (opts.path ? 'localhost' : opts.host) : typeof args[1] === 'string' ? args[1] : undefined
  if (!LOOPBACK.has(host)) throw new Error(`Real network call blocked in a test: ${host}. Mock it instead.`)
  return (connect as (...a: unknown[]) => net.Socket).apply(this, args)
} as typeof connect
