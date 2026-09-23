// Self-check for the phone store's reducers that feed the Composer line. Run it with:
//
//   node --experimental-strip-types src/store.check.ts
//
// Two things differ from the web store and are pinned here on purpose: the phone
// never streams a reply, so updateChat does not move the line; and the
// conversation outlives the document, so clearDoc keeps the chat.
import assert from 'node:assert/strict'
import { useStore } from './store.ts'
import type { LibraryDoc } from './types.ts'

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
  s.setDoc(doc, libraryDoc, 99, [])
  assert.equal(useStore.getState().currentParagraph, 2, 'a bookmark past the end lands on the last paragraph')
  assert.equal(useStore.getState().screen, 'reader')
  assert.equal(useStore.getState().playing, false)
  s.setDoc(doc, libraryDoc, -5, [])
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

console.log('store.check.ts: ok')
