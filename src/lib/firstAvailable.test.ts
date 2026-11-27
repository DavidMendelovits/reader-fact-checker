// The ear chooser (firstAvailable.ts): the streaming vendor when the server
// offers it, the browser's recognizer when not, decided once; the app's handlers
// reach it whichever was chosen; and a mic turned off mid-choice stays off.
import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { FirstAvailable, type Preferred } from './firstAvailable.ts'

function ear(name: string, opts: { available?: () => Promise<boolean | null>; supported?: boolean } = {}) {
  const log: string[] = []
  const t = {
    supported: opts.supported ?? true,
    log,
    available: opts.available ?? (async () => true),
    start: async () => void log.push(`${name} start`),
    stop: () => void log.push(`${name} stop`),
    setUserMuted: (m: boolean) => void log.push(`${name} muted ${m}`),
    setPlaying: () => {},
    onUtterance: (_: string) => {},
    onInterim: (_: string) => {},
    onSpeechStart: () => {},
    onFalseStart: () => {},
    onError: (_: string) => {},
    getSpokenText: () => '',
    getRecentSpokenText: () => '',
  }
  return t
}

describe('FirstAvailable', () => {
  it('runs the vendor when the server offers it, and passes its turns through', async () => {
    const flux = ear('flux')
    const chrome = ear('chrome')
    const v = new FirstAvailable(flux as Preferred, chrome)
    const heard: string[] = []
    v.onUtterance = (t) => heard.push(t)
    v.getRecentSpokenText = () => 'the book'
    await v.start()
    flux.onUtterance('next chapter')
    assert.deepEqual(heard, ['next chapter'])
    assert.equal(flux.getRecentSpokenText(), 'the book', 'the echo filter reads what is playing')
    assert.deepEqual(flux.log, ['flux start'])
    assert.deepEqual(chrome.log, [])
  })

  it('falls back to the browser when the server has no vendor, and asks only once', async () => {
    let asked = 0
    const flux = ear('flux', { available: async () => (asked++, false) })
    const chrome = ear('chrome')
    const v = new FirstAvailable(flux as Preferred, chrome)
    await v.start()
    v.stop()
    await v.start()
    assert.equal(asked, 1)
    assert.deepEqual(chrome.log, ['chrome start', 'chrome stop', 'chrome start'])
  })

  it('stays off when the mic goes off while the server is answering', async () => {
    let answer!: (ok: boolean) => void
    const flux = ear('flux', { available: () => new Promise((r) => (answer = r)) })
    const v = new FirstAvailable(flux as Preferred, ear('chrome'))
    const starting = v.start()
    v.stop()
    answer(true)
    await starting
    assert.deepEqual(flux.log, [])
  })

  it('says so when the browser can do neither, and stops offering the mic', async () => {
    const v = new FirstAvailable(ear('flux', { available: async () => false }) as Preferred, ear('chrome', { supported: false }))
    const errors: string[] = []
    v.onError = (m) => errors.push(m)
    assert.equal(v.supported, true, 'before the first tap it might work')
    await v.start()
    assert.deepEqual(errors, ['Mic needs Chrome — type instead'])
    assert.equal(v.supported, false, 'now the Composer shows its hint')
  })

  it('asks again on the next tap when the server could not answer', async () => {
    const answers: (boolean | null)[] = [null, true]
    const flux = ear('flux', { available: async () => answers.shift()! })
    const chrome = ear('chrome')
    const v = new FirstAvailable(flux as Preferred, chrome)
    await v.start()
    assert.deepEqual(chrome.log, ['chrome start'], 'Chrome covers the tap the server missed')
    v.stop()
    await v.start()
    assert.deepEqual(flux.log, ['flux start'], 'and the next tap gets the vendor')
  })

  it('with nothing to fall back on, a server that could not answer says try again', async () => {
    const v = new FirstAvailable(ear('flux', { available: async () => null }) as Preferred, ear('chrome', { supported: false }))
    const errors: string[] = []
    v.onError = (m) => errors.push(m)
    await v.start()
    assert.match(errors[0], /try again/)
    assert.equal(v.supported, true, 'still worth offering the mic')
  })
})
