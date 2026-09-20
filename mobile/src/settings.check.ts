// Self-check for the settings that guard the token and the once-a-day hello.
// Run it with:
//
//   node --experimental-strip-types src/settings.check.ts
//
// The token moved from AsyncStorage to the keychain; an install that predates the
// move must be migrated on its first load, not signed out. And the agent's hello
// is spoken on the first launch of a calendar day only (3.1A).
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

// settings.ts imports react-native, AsyncStorage and expo-secure-store at module
// top. Two in-memory maps stand in for the two stores; both are reachable from
// the check through globalThis.
const RN = 'data:text/javascript,export const Platform={OS:"ios",select:(o)=>o.ios??o.default};'
const ASYNC =
  'data:text/javascript,' +
  encodeURIComponent(`
const m = new Map(); globalThis.__async = m;
export default {
  getItem: async (k) => m.get(k) ?? null,
  setItem: async (k, v) => { m.set(k, v) },
  removeItem: async (k) => { m.delete(k) },
}`)
const SECURE =
  'data:text/javascript,' +
  encodeURIComponent(`
const m = new Map(); globalThis.__secure = m;
// globalThis.__secureFails stands in for a keychain that is not available.
const check = () => { if (globalThis.__secureFails) throw new Error('keychain unavailable') };
export const getItemAsync = async (k) => { check(); return m.get(k) ?? null };
export const setItemAsync = async (k, v) => { check(); m.set(k, v) };
export const deleteItemAsync = async (k) => { check(); m.delete(k) };
`)
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === 'react-native') return { url: RN, shortCircuit: true }
    if (spec.includes('async-storage')) return { url: ASYNC, shortCircuit: true }
    if (spec === 'expo-secure-store') return { url: SECURE, shortCircuit: true }
    return next(spec, ctx)
  },
})

const { loadSettings, saveToken, clearToken, shouldSayHello } = await import('./settings.ts')
const async = (globalThis as any).__async as Map<string, string>
const secure = (globalThis as any).__secure as Map<string, string>

const flush = () => new Promise((r) => setTimeout(r, 0))

// an install from before the keychain: the token is moved, not lost
{
  async.set('readwise-token', 'tok-old')
  const first = await loadSettings()
  assert.equal(first.token, 'tok-old', 'the old token signs the reader in')
  assert.equal(secure.get('readwise-token'), 'tok-old', 'and now lives in the keychain')
  assert.equal(async.has('readwise-token'), false, 'and no longer in AsyncStorage')

  // the next load reads the keychain and leaves AsyncStorage alone
  async.set('readwise-token', 'stale')
  const second = await loadSettings()
  assert.equal(second.token, 'tok-old')
  assert.equal(async.get('readwise-token'), 'stale', 'no migration once the keychain has it')
  async.delete('readwise-token')

  // defaults for the rest when nothing is stored
  assert.equal(second.voice, 'system')
  assert.equal(second.theme, 'system')
}

// save trims and goes to the keychain only; sign-out forgets both
{
  await saveToken('  tok-new \n')
  assert.equal(secure.get('readwise-token'), 'tok-new')
  assert.equal(async.has('readwise-token'), false)
  async.set('readwise-token', 'leftover')
  await clearToken()
  assert.equal(secure.has('readwise-token'), false)
  assert.equal(async.has('readwise-token'), false, 'a leftover in the old store goes too')
  assert.equal((await loadSettings()).token, null, 'the next launch shows sign-in')
}

// the hello: once per calendar day, remembered across launches
{
  const today = new Date().toDateString()
  async.delete('last-hello-day')
  await loadSettings()
  assert.equal(shouldSayHello(), true, 'a fresh day gets the hello')
  assert.equal(shouldSayHello(), false, 'asked twice, said once')
  await flush()
  assert.equal(async.get('last-hello-day'), today, 'the day is written down')

  async.set('last-hello-day', today)
  await loadSettings()
  assert.equal(shouldSayHello(), false, 'a relaunch on the same day is quiet')

  async.set('last-hello-day', 'Mon Jan 01 2001')
  await loadSettings()
  assert.equal(shouldSayHello(), true, 'a new day speaks again')
}

// a keychain that throws signs nobody out: the old token still loads, and stays
// where it is so the next launch can try the move again
{
  async.set('readwise-token', 'tok-kept')
  secure.clear()
  ;(globalThis as any).__secureFails = true
  const loaded = await loadSettings()
  ;(globalThis as any).__secureFails = false
  assert.equal(loaded.token, 'tok-kept', 'the reader is signed in from the store that still works')
  assert.equal(async.get('readwise-token'), 'tok-kept', 'and nothing was removed')
  assert.equal(secure.has('readwise-token'), false)
  async.delete('readwise-token')
}

console.log('settings.check.ts: ok')
