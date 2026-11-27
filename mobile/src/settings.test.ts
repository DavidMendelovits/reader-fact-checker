// Tests for the settings that guard the token, the access code and the once-a-day hello.
// The token moved from AsyncStorage to the keychain; an install that predates the
// move must be migrated on its first load, not signed out. And the agent's hello
// is spoken on the first launch of a calendar day only (3.1A).
// AsyncStorage and the keychain are in-memory maps (test/stubs), read here
// through globalThis.
import assert from 'node:assert/strict'
import { onTestFinished, test } from 'vitest'
import { loadSettings, saveToken, clearToken, shouldSayHello, saveAppToken, apiHeaders } from './settings.ts'
const async = (globalThis as any).__async as Map<string, string>
const secure = (globalThis as any).__secure as Map<string, string>

const flush = () => new Promise((r) => setTimeout(r, 0))

test('an install from before the keychain: the token is moved, not lost', async () => {
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
})

test('save trims and goes to the keychain only; sign-out forgets both', async () => {
  await saveToken('  tok-new \n')
  assert.equal(secure.get('readwise-token'), 'tok-new')
  assert.equal(async.has('readwise-token'), false)
  async.set('readwise-token', 'leftover')
  await clearToken()
  assert.equal(secure.has('readwise-token'), false)
  assert.equal(async.has('readwise-token'), false, 'a leftover in the old store goes too')
  assert.equal((await loadSettings()).token, null, 'the next launch shows sign-in')
})

test('the hello: once per calendar day, remembered across launches', async () => {
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
})

// a keychain that throws signs nobody out: the old token still loads, and stays
// where it is so the next launch can try the move again
test('a keychain that throws signs nobody out: the old token still loads, and stays where it is so the next...', async () => {
  async.set('readwise-token', 'tok-kept')
  secure.clear()
  ;(globalThis as any).__secureFails = true
  onTestFinished(() => {
    ;(globalThis as any).__secureFails = false
  })
  const loaded = await loadSettings()
  assert.equal(loaded.token, 'tok-kept', 'the reader is signed in from the store that still works')
  assert.equal(async.get('readwise-token'), 'tok-kept', 'and nothing was removed')
  assert.equal(secure.has('readwise-token'), false)
  async.delete('readwise-token')
})


test('the access code: kept in the keychain, sent on every request, cleared by a blank', async () => {
  assert.deepEqual(apiHeaders(), { 'Content-Type': 'application/json' }, 'no code, no header')
  await saveAppToken('  sesame ')
  assert.equal(secure.get('app-token'), 'sesame')
  assert.equal(apiHeaders()['x-app-token'], 'sesame')
  await saveAppToken('')
  assert.equal(secure.has('app-token'), false)
  assert.equal(apiHeaders()['x-app-token'], undefined)

  // a relaunch reads it back
  secure.set('app-token', 'kept')
  await loadSettings()
  assert.equal(apiHeaders()['x-app-token'], 'kept')
  secure.delete('app-token')
  await loadSettings()
  assert.equal(apiHeaders()['x-app-token'], undefined)
})
