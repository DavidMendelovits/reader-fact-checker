// Self-check for the phone store's reducers that feed the Composer line. Run it with:
//
//   node --experimental-strip-types src/store.check.ts
//
// Two things differ from the web store and are pinned here on purpose: the phone
// never streams a reply, so updateChat does not move the line; and the
// conversation outlives the document, so clearDoc keeps the chat.
import assert from 'node:assert/strict'
import { useStore } from './store.ts'
import type { Check, LibraryDoc } from './types.ts'

const doc = { id: 'd', title: 'T', source: 's', chapters: [{ title: 'One', paragraphs: ['a', 'b', 'c'] }] }
const libraryDoc: LibraryDoc = {
  id: 'd', title: 'T', author: null, category: null, location: 'new', sourceUrl: null,
  wordCount: null, summary: null, tags: [], readingProgress: null, publishedDate: null, updatedAt: '2026-01-01T00:00:00Z',
}

// the line is the agent's last non-empty reply, set on push and only on push
{
  const s = useStore.getState()
  s.pushChat({ id: 'u1', role: 'user', text: 'hello' })
  assert.equal(useStore.getState().lastAgentLine, null)

  s.pushChat({ id: 'a0', role: 'assistant', text: '   ' })
  assert.equal(useStore.getState().lastAgentLine, null, 'a blank reply is not a line')
  assert.equal(useStore.getState().lastAgentLineAt, null)

  s.pushChat({ id: 'a1', role: 'assistant', text: 'Paused.' })
  assert.equal(useStore.getState().lastAgentLine, 'Paused.')
  const at = useStore.getState().lastAgentLineAt
  assert.ok(at !== null && Date.now() - at < 1000)

  s.updateChat('u1', { text: 'hello there' })
  assert.equal(useStore.getState().chat[0].text, 'hello there', 'a partial\'s bubble is corrected in place')
  assert.equal(useStore.getState().lastAgentLine, 'Paused.')
  assert.equal(useStore.getState().chat.length, 3)
}

// open clamps the saved position and shows the reader; close keeps the chat,
// clears the line and goes back to the library
{
  const s = useStore.getState()
  s.setDoc(doc, libraryDoc, 99, [], [])
  assert.equal(useStore.getState().currentParagraph, 2, 'a bookmark past the end lands on the last paragraph')
  assert.equal(useStore.getState().screen, 'reader')
  assert.equal(useStore.getState().playing, false)
  s.setDoc(doc, libraryDoc, -5, [], [])
  assert.equal(useStore.getState().currentParagraph, 0, 'and one before the start lands on the first')

  s.pushChat({ id: 'a2', role: 'assistant', text: 'Reading.' })
  s.clearDoc()
  const after = useStore.getState()
  assert.equal(after.screen, 'library')
  assert.equal(after.doc, null)
  assert.equal(after.libraryDoc, null)
  assert.deepEqual(after.paragraphs, [])
  assert.equal(after.currentParagraph, 0)
  assert.equal(after.lastAgentLine, null, 'the stale line is cleared on close')
  assert.equal(after.lastAgentLineAt, null)
  assert.equal(after.chat.length, 4, 'the conversation outlives the document on the phone')
}

// the hold on the line starts when the voice stops, not when the text was pushed:
// a long reply would otherwise be stale the moment it finished being spoken
{
  const s = useStore.getState()
  s.pushChat({ id: 'a3', role: 'assistant', text: 'It was 1913.' })
  const pushedAt = useStore.getState().lastAgentLineAt!
  s.setAgentState('speaking')
  while (Date.now() === pushedAt) { /* the speaking has to take at least a tick */ }

  const before = Date.now()
  s.setAgentState('idle')
  assert.equal(useStore.getState().agentState, 'idle')
  const restamped = useStore.getState().lastAgentLineAt!
  assert.ok(restamped >= before, 'leaving speaking restarts the hold')
  assert.ok(restamped > pushedAt, 'and the push-time stamp is not what the line holds to')

  // idle → idle is not the end of anything
  s.setAgentState('idle')
  assert.equal(useStore.getState().lastAgentLineAt, restamped, 'a non-transition leaves the clock alone')
  s.setAgentState('listening')
  assert.equal(useStore.getState().lastAgentLineAt, restamped, 'and so does any other state that did not follow speech')

  // with nothing on the line there is nothing to hold
  s.clearDoc()
  assert.equal(useStore.getState().lastAgentLine, null)
  s.setAgentState('speaking')
  s.setAgentState('idle')
  assert.equal(useStore.getState().lastAgentLineAt, null, 'no line, no timestamp')
}

// ---- the checks a document keeps ----
const check = (id: string, over: Partial<Check> = {}): Check => ({
  id, claim: `claim ${id}`, verdict: 'Mostly true', summary: 'Checks out.', sources: [],
  anchorText: 'He was an old man', anchor: 3, createdAt: 1, ...over,
})

{
  const s = useStore.getState()
  s.setDoc(doc, libraryDoc, 0, [], [])
  assert.deepEqual(useStore.getState().checks, [], 'a fresh open has no checks')

  s.addCheck('d', check('c1'))
  s.addCheck('d', check('c2'))
  assert.deepEqual(useStore.getState().checks.map((c) => c.id), ['c1', 'c2'], 'checks append, oldest first')

  // a check that came back after the reader moved on belongs to a closed book
  s.addCheck('other', check('c3'))
  assert.deepEqual(useStore.getState().checks.map((c) => c.id), ['c1', 'c2'], 'a stale docId is ignored')

  // the cap drops the oldest, not the newest
  for (let i = 0; i < 60; i++) s.addCheck('d', check(`n${i}`))
  const kept = useStore.getState().checks
  assert.equal(kept.length, 50, 'fifty is the ceiling')
  assert.equal(kept[0].id, 'n10', 'the oldest fell off')
  assert.equal(kept[49].id, 'n59', 'the newest is still there')

  s.clearDoc()
  assert.deepEqual(useStore.getState().checks, [], 'closing the document clears its checks')

  // and the saved ones come back with the document
  s.setDoc(doc, libraryDoc, 0, [], [check('saved')])
  assert.deepEqual(useStore.getState().checks.map((c) => c.id), ['saved'], 'setDoc loads the saved checks')
  s.clearDoc()
}

// ---- the jump a check's row asks for ----
{
  const s = useStore.getState()
  assert.equal(useStore.getState().pendingJump, null)
  s.requestJump(7)
  assert.equal(useStore.getState().pendingJump, 7)
  s.requestJump(null)
  assert.equal(useStore.getState().pendingJump, null, 'the list puts it back once it has scrolled')

  // opening and closing a document never leaves one pending
  s.requestJump(4)
  s.setDoc(doc, libraryDoc, 0, [], [])
  assert.equal(useStore.getState().pendingJump, null)
  s.requestJump(4)
  s.clearDoc()
  assert.equal(useStore.getState().pendingJump, null)
}

console.log('store.check.ts: ok')
