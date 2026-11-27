// Preloaded into every phone-app check by scripts/test.mjs: no test may reach a real
// API. Loopback is allowed, because some checks stand up a local fake server;
// anything else fails loudly here instead of spending money or flaking on the
// network. A check that needs a vendor's answer uses the fake providers
// (api/_lib/adapters/fake.ts), its own fake fetch, or a local server.
const realFetch = globalThis.fetch
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  if (LOOPBACK.has(url.hostname)) return realFetch(input, init)
  throw new Error(`Real network call blocked in a check: ${url.href}. Fake it instead.`)
}
