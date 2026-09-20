// The whole app, end to end, in a browser. Drives the web build of the phone
// app against smoke/fake-backend.mjs (a stand-in Reader library and a scripted
// model), the way a person would: sign in, search, open a book by typing what
// they'd say, let it read, talk over it, highlight by long-press and by voice,
// note, remove, archive, close, reopen to the saved position, try a PDF, lose
// the network, sign out.
//
// The UI is one Composer bar now (mic · line · play · transcript · keyboard), so
// everything the old footer said is read off `composer-line` and everything that
// used to be typed goes through the keyboard glyph. Utterances beginning with ">"
// are pushed through the ear's own handlers — speech start, interim, final —
// which is how barge-in is driven without a microphone.
//
// Run through `npm run smoke:web` (see run.mjs), which builds and serves the
// app and the backend first. Fails loudly on the first wrong thing.
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'

const APP = process.env.SMOKE_APP_URL ?? 'http://localhost:8082'
const BACKEND = process.env.SMOKE_BACKEND_URL ?? 'http://localhost:5300'
const CHROME = process.env.SMOKE_CHROME ?? process.env.AGENT_BROWSER_EXECUTABLE_PATH ?? undefined

const VIEWPORT = { width: 390, height: 844 }
/** Paper's `danger`, which is what a failed sync paints the hairline. */
const DANGER = 'rgb(138, 59, 43)'

const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {})
const page = await browser.newPage({ viewport: VIEWPORT })

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

/** Turn one of the backend's failure switches on or off (`list=1`, `agent=1`). */
const failNext = (query) => fetch(`${BACKEND}/__fail?${query}`)

// ---- the Composer ----
// The bar collapses after every send, so the glyph is tapped before each line.
const typeIt = async (text) => {
  await page.getByTestId('composer-keyboard').click()
  await page.getByTestId('composer-input').fill(text)
  await page.getByTestId('composer-input').press('Enter')
}
const sayIt = async (text, settleMs = 4000) => {
  await typeIt(text)
  await page.waitForTimeout(settleMs)
}
const lineText = () => page.getByTestId('composer-line').innerText()
/**
 * Where the voice is, read off the line — which shows it only while it is
 * actually reading: the agent's reply holds the line for three seconds after it
 * has been spoken (1.1A), so anything that just talked needs settling first.
 */
const position = async () => {
  const m = (await lineText()).match(/¶(\d+)\/22/)
  return m ? Number(m[1]) : null
}
const waitForPosition = async (timeout = 8000) => {
  const deadline = Date.now() + timeout
  for (;;) {
    const at = await position()
    if (at !== null) return at
    if (Date.now() > deadline) throw new Error(`the line never showed a position: "${await lineText()}"`)
    await page.waitForTimeout(100)
  }
}
const inTheViewport = async (locator) => {
  const box = await locator.boundingBox()
  return !!box && box.y >= 0 && box.y < VIEWPORT.height && box.x >= 0
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
assert.ok(await page.getByRole('button', { name: 'Pause', exact: true }).isVisible(), 'reading after open')

// ---- barge-in: the book stops at the first word, not at the end of the sentence ----
const reading = await waitForPosition()
await typeIt('>wait') // through the ear: speech start, interim, final
await page.getByRole('button', { name: 'Play', exact: true }).waitFor({ timeout: 300 })
const held = await lineText()
assert.ok(/Paused|Listening|Thinking/i.test(held), `the line shows the interruption, got "${held}"`)
const stoppedAt = await position()
assert.ok(stoppedAt === null || stoppedAt <= reading + 1, `the voice did not read on (¶${reading} → ¶${stoppedAt})`)
step(`barge-in: "wait" stops the voice inside 300ms (¶${reading})`)

// ---- fast resume (X4): "keep going" used to be acknowledged and play nothing ----
await typeIt('>stop')
await page.waitForTimeout(400)
await typeIt('>keep going')
await page.getByRole('button', { name: 'Pause', exact: true }).waitFor({ timeout: 2000 })
const resumed = await waitForPosition()
assert.ok(resumed > reading, `the voice moved on after "keep going" (¶${reading} → ¶${resumed})`)
step(`fast resume: "keep going" plays, from ¶${reading} to ¶${resumed}`)

// ---- chapters by voice, the same way ----
await page.getByRole('button', { name: 'Pause', exact: true }).click()
await sayIt('skip to chapter two', 4500)
const where = await waitForPosition()
assert.ok(where >= 8 && where < 13, `reading chapter two (¶${where})`)
assert.ok(await page.getByRole('button', { name: 'Pause', exact: true }).isVisible(), 'reading after the jump')
step(`chapter jump through the decision model (¶${where}/22)`)

// ---- speed lives in the header now, and the sheet behind it ----
assert.equal((await page.getByTestId('speed-pill').innerText()).trim(), '1.0×')
await page.getByTestId('speed-pill').click()
await page.getByRole('button', { name: 'Speed, 1.2×' }).click()
assert.equal((await page.getByTestId('speed-pill').innerText()).trim(), '1.2×')
await page.getByTestId('speed-pill').click()
await page.getByRole('button', { name: 'Speed, 1.0×' }).click()
step('speed pill and sheet')

// ---- highlight by long-press, note, remove ----
// pause first: a long-press while the list follows the narration gets cancelled
// by the scroll, on the web and on a phone alike
await page.getByRole('button', { name: 'Pause', exact: true }).click()
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
await sayIt('archive that', 2500)
assert.ok(wire.some((w) => w === 'PATCH /api/v3/update/doc-sea/'), 'moved in Reader')
// filing moved into the transcript sheet (1.2A)
await page.getByTestId('composer-transcript').click()
await page.getByRole('button', { name: /Filed in Archive/ }).waitFor()
await page.getByRole('button', { name: 'Close the transcript' }).last().click()
await sayIt('back to the library', 2000)
await page.getByRole('button', { name: 'Inbox' }).waitFor()
step('agent highlight; archive (read back in the transcript sheet) and close')

// ---- a document with no text does not disturb anything ----
await page.getByRole('button', { name: 'Archive', exact: true }).click()
await page.getByRole('button', { name: /Old Man and the Sea/ }).click()
await page.getByText('Chapter 1: The Harbour').waitFor()
await sayIt('open the pdf', 3000)
assert.ok(await page.getByRole('button', { name: 'Back to library' }).isVisible(), 'book still open after a failed open')
step('opening a PDF fails cleanly, the book stays open')

// ---- reopen at the bookmark: already positioned, no scroll from the top ----
await sayIt('back to the library', 3000)
await page.getByRole('button', { name: /Old Man and the Sea/ }).click()
await page.getByText('Chapter 1: The Harbour').waitFor()
const bookmark = await waitForPosition()
assert.notEqual(bookmark, 1, 'reopened past the start rather than reading from ¶1')
const currentRow = page.getByLabel(new RegExp(`^(Paragraph|Chapter heading) ${bookmark}\\.`))
assert.ok(await inTheViewport(currentRow), `the voice's paragraph (¶${bookmark}) is on screen at the first paint`)
step(`reopen resumes at the saved position (¶${bookmark}/22), row already on screen`)
// the failed open is in the history the model saw on that reopen
assert.ok(modelHeard('already did this: Could not open that') && modelHeard('no readable text'), 'the model was told why the PDF did not open')

// ---- the keyboard: the field is above the keyboard, not under it (K1/6.2A) ----
await page.getByTestId('composer-keyboard').click()
const field = page.getByTestId('composer-input')
await field.waitFor()
assert.ok(await inTheViewport(field), 'the text field is inside the viewport')
await page.getByRole('button', { name: 'Close the keyboard' }).click()
step('keyboard glyph reveals a field that is not occluded')

// ---- a failed sync is a red hairline and one line, never a toast ----
await page.getByRole('button', { name: 'Back to library' }).click()
await page.getByRole('button', { name: 'Settings', exact: true }).click()
await failNext('list=1')
await page.getByRole('button', { name: 'Resync library' }).click()
await page.waitForFunction(
  () => document.querySelector('[data-testid="composer-line"]')?.innerText?.includes("Couldn't sync"),
  null,
  { timeout: 5000 },
)
assert.match(await lineText(), /Couldn't sync\. Showing what's saved\./)
await page.getByRole('button', { name: 'Back to library' }).click()
const hairline = page.getByTestId('sync-hairline')
await hairline.waitFor()
assert.equal(
  await hairline.evaluate((el) => getComputedStyle(el).backgroundColor),
  DANGER,
  'the sync hairline reads red',
)
await failNext('list=0')
step('a failed sync: red hairline, and the line says what happened')

// ---- offline mid-turn: the model is gone, the book is not ----
await failNext('agent=1')
await sayIt('what should i read next', 3000)
assert.match(await lineText(), /Offline\. Reading still works\./)
await failNext('agent=0')
step('offline mid-turn says so in the line')

// ---- sign out ----
await page.getByRole('button', { name: 'Settings', exact: true }).click()
await page.getByRole('button', { name: 'Sign out' }).click()
await page.getByPlaceholder('Access token').waitFor()
step('sign out')

// The browser logs the failures this test asked for, and the ones a headless
// browser always has (no microphone, no speech synthesis).
const EXPECTED = /Microphone|not-allowed|speechSynthesis|AudioContext|Failed to load resource|Failed to fetch|net::ERR/i
const real = errors.filter((e) => !EXPECTED.test(e))
assert.deepEqual(real, [], `page errors: ${real.join(' | ')}`)
await browser.close()
console.log('smoke:web ok')
