// The whole app, end to end, in a browser. Drives the web build of the phone
// app against smoke/fake-backend.mjs (a stand-in Reader library and a scripted
// model), the way a person would: sign in, search, open a book by typing what
// they'd say, let it read, highlight by long-press and by voice, note, remove,
// archive, close, reopen to the saved position, try a PDF, sign out.
//
// Run through `npm run smoke:web` (see run.mjs), which builds and serves the
// app and the backend first. Fails loudly on the first wrong thing.
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'

const APP = process.env.SMOKE_APP_URL ?? 'http://localhost:8082'
const CHROME = process.env.SMOKE_CHROME ?? process.env.AGENT_BROWSER_EXECUTABLE_PATH ?? undefined

const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {})
const page = await browser.newPage({ viewport: { width: 390, height: 844 } })

// dialogs are the web stand-in for native action sheets; answer by number
let answer = '1'
page.on('dialog', (d) => d.accept(answer))
const wire = []
const toldTheModel = [] // what the app sent the conversation model
page.on('request', (r) => {
  const u = new URL(r.url())
  if (u.pathname.startsWith('/api/')) wire.push(`${r.method()} ${u.pathname}${u.search ? '?' + u.searchParams.toString() : ''}`)
  if (u.pathname === '/api/agent') toldTheModel.push(r.postData() ?? '')
})
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })

const sayIt = async (text, settleMs = 4000) => {
  await page.getByPlaceholder('or type it…').first().fill(text)
  await page.getByPlaceholder('or type it…').first().press('Enter')
  await page.waitForTimeout(settleMs)
}
const counter = () => page.getByRole('button', { name: /^[0-9]+ highlights?$/ }).textContent()
const longPress = async (locator) => {
  await locator.scrollIntoViewIfNeeded()
  await page.waitForTimeout(400)
  const box = await locator.boundingBox()
  await page.mouse.move(box.x + 40, box.y + 8)
  await page.mouse.down()
  await page.waitForTimeout(700)
  await page.mouse.up()
  await page.waitForTimeout(1200)
}
const step = (name) => console.log(`✓ ${name}`)

// ---- sign in ----
await page.goto(APP)
await page.getByPlaceholder('Access token').fill('test-token')
await page.getByRole('button', { name: 'Open my library' }).click()
await page.getByRole('button', { name: /Why We Sleep/ }).waitFor()
assert.ok(wire.some((w) => w.startsWith('GET /api/v3/list/?location=new')), 'library sync')
step('sign in and sync the library')

// ---- search ----
await page.getByPlaceholder('Search your library').fill('hemingway')
await page.getByRole('button', { name: /Old Man and the Sea/ }).waitFor()
await page.getByPlaceholder('Search your library').fill('')
step('search finds a book in another tab')

// ---- open by voice: the decision model names the book, no conversation turn ----
await sayIt('open the hemingway book', 4000)
await page.getByText('Chapter 1: The Harbour').waitFor()
assert.ok(wire.some((w) => w === 'POST /api/navigate'), 'asked the decision model')
// the app opened it on the decision; the model only heard about it afterwards
const modelCalled = (name) => toldTheModel.some((b) => JSON.parse(b).messages.some((m) => Array.isArray(m.content) && m.content.some((x) => x.type === 'tool_use' && x.name === name)))
assert.ok(!modelCalled('open_document') && !modelCalled('search_library'), 'the model did not do the opening')
step('open by typed command through the decision model, chapters split, remote highlight painted, reading')
// did the model's history, in any request, carry these words?
const modelHeard = (words) => toldTheModel.some((b) => JSON.parse(b).messages.some((m) => (typeof m.content === 'string' ? m.content : m.content.map((x) => x.text ?? x.content ?? '').join(' ')).includes(words)))
assert.ok(wire.some((w) => w.includes('withHtmlContent')), 'fetched the book text')
assert.equal(await counter(), '1 highlight', "Reader's own highlight adopted")
assert.ok(await page.getByRole('button', { name: 'Pause' }).isVisible(), 'reading after open')

// ---- chapters by voice, the same way ----
await page.getByRole('button', { name: 'Pause' }).click()
await sayIt('skip to chapter two', 1500)
const where = Number((await page.getByText(/¶\d+\/22/).textContent()).match(/¶(\d+)/)[1])
assert.ok(where >= 8 && where < 13, `reading chapter two (¶${where})`)
assert.ok(await page.getByRole('button', { name: 'Pause' }).isVisible(), 'reading after the jump')
step(`chapter jump through the decision model (¶${where}/22)`)

// ---- highlight by long-press, note, remove ----
// pause first: a long-press while the list follows the narration gets cancelled
// by the scroll, on the web and on a phone alike
await page.getByRole('button', { name: 'Pause' }).click()
await page.waitForTimeout(600)
await longPress(page.getByText('Sea paragraph 1.3.', { exact: false }).first())
assert.equal(await counter(), '2 highlights', 'long-press painted a highlight')
assert.ok(wire.some((w) => w === 'POST /api/v2/highlights/'), 'highlight written to Readwise')
answer = '1' // add note
await page.getByText('Sea paragraph 1.3.', { exact: false }).first().click()
await page.getByPlaceholder(/note/i).first().fill('for the talk')
await page.getByRole('button', { name: 'Save' }).click()
await page.waitForTimeout(400)
assert.equal(await page.locator('text=✎').count(), 2, 'note marker painted')
answer = '2' // remove
await page.getByText('Sea paragraph 1.3.', { exact: false }).first().click()
await page.waitForTimeout(1500)
assert.equal(await counter(), '1 highlight', 'removed')
assert.ok(wire.some((w) => /^DELETE \/api\/v2\/highlights\/\d+\/$/.test(w)), 'delete sent to Readwise')
step('long-press highlight, note, remove')

// ---- highlight, list, archive, close by voice ----
await sayIt('highlight that', 5000)
assert.equal(await counter(), '2 highlights', 'agent highlight painted')
assert.ok(modelHeard('Opened "The Old Man and the Sea"'), 'the model was told the app opened the book')
await sayIt('archive that', 2000)
await page.getByRole('button', { name: 'Archive ▾' }).waitFor()
assert.ok(wire.some((w) => w === 'PATCH /api/v3/update/doc-sea/'), 'moved in Reader')
await sayIt('back to the library', 2000)
await page.getByRole('button', { name: 'Inbox' }).waitFor()
step('agent highlight; archive and close through the decision model')

// ---- a document with no text does not disturb anything ----
await page.getByRole('button', { name: 'Archive' }).click()
await page.getByRole('button', { name: /Old Man and the Sea/ }).click()
await page.getByText('Chapter 1: The Harbour').waitFor()
await sayIt('open the pdf', 3000)
assert.ok(await page.getByRole('button', { name: 'Archive ▾' }).isVisible(), 'book still open after a failed open')
step('opening a PDF fails cleanly, the book stays open')

// ---- resume ----
await sayIt('back to the library', 3000)
await page.getByRole('button', { name: /Old Man and the Sea/ }).click()
await page.getByText('Chapter 1: The Harbour').waitFor()
await page.waitForTimeout(1500)
const pos = await page.getByText(/¶\d+\/22/).textContent()
assert.notEqual(pos.trim(), '1x · ¶1/22', `resumed past the start (${pos})`)
step(`reopen resumes at the saved position (${pos.trim()})`)
// the failed open is in the history the model saw on that reopen
assert.ok(modelHeard('already did this: Could not open that') && modelHeard('no readable text'), 'the model was told why the PDF did not open')

// ---- sign out ----
await page.getByRole('button', { name: 'Back to library' }).click()
await page.getByRole('button', { name: 'settings' }).click()
await page.getByRole('button', { name: 'Sign out' }).click()
await page.getByPlaceholder('Access token').waitFor()
step('sign out')

const real = errors.filter((e) => !/Microphone|not-allowed|speechSynthesis|AudioContext/i.test(e))
assert.deepEqual(real, [], `page errors: ${real.join(' | ')}`)
await browser.close()
console.log('smoke:web ok')
