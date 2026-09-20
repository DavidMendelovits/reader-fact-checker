// Self-check for the store's reducers that feed the Composer line. Run it with:
//
//   node --experimental-strip-types src/store.check.ts
//
// The line shows the agent's last reply without walking the chat log, so the
// reducers have to keep `lastAgentLine` honest: a streamed reply arrives as one
// push and a run of patches, and a new document is a new conversation.
import assert from 'node:assert/strict'
import { useStore } from './store.ts'

const doc = { id: 'd', title: 'T', source: 's', chapters: [{ title: 'One', paragraphs: ['a', 'b'] }] }

// a streamed reply: the line follows the patches, and only the assistant's
{
  const s = useStore.getState()
  s.pushChat({ id: 'u1', role: 'user', text: 'hello' })
  assert.equal(useStore.getState().lastAgentLine, null, 'the user speaking is not the agent line')

  s.pushChat({ id: 'a1', role: 'assistant', text: 'All' })
  assert.equal(useStore.getState().lastAgentLine, 'All')
  const firstAt = useStore.getState().lastAgentLineAt
  assert.ok(firstAt !== null && Date.now() - firstAt < 1000)

  s.updateChat('a1', { text: 'All right.' })
  assert.equal(useStore.getState().lastAgentLine, 'All right.', 'the line keeps up with the stream')
  assert.equal(useStore.getState().chat.find((m) => m.id === 'a1')?.text, 'All right.')
  assert.equal(useStore.getState().lastAgentLineAt, firstAt, 'a delta of the held line does not restart the hold')

  while (Date.now() === firstAt) { /* the clock has to tick for the next assertion to mean anything */ }
  s.updateChat('a1', { text: 'All right, reading.' })
  assert.equal(useStore.getState().lastAgentLineAt, firstAt, 'and neither does the one after it')

  s.updateChat('u1', { text: 'hello there' })
  assert.equal(useStore.getState().lastAgentLine, 'All right, reading.', 'correcting a user bubble leaves the line alone')

  s.updateChat('a1', {})
  assert.equal(useStore.getState().lastAgentLine, 'All right, reading.', 'a patch with no text leaves the line alone')

  s.updateChat('missing', { text: 'ghost' })
  assert.equal(useStore.getState().lastAgentLine, 'All right, reading.', 'a patch to nothing changes nothing')
  assert.equal(useStore.getState().chat.length, 2)

  // but a second reply is a new line, and the hold starts over for it
  s.pushChat({ id: 'a2', role: 'assistant', text: 'Anything else?' })
  const secondAt = useStore.getState().lastAgentLineAt
  assert.ok(secondAt !== null && secondAt > firstAt, 'a new agent line moves the timestamp')
  s.updateChat('a1', { text: 'All right, reading. (corrected)' })
  assert.ok(useStore.getState().lastAgentLineAt! > firstAt, 'so does a patch that takes the line back')
}

// a new document is a new conversation, and closing one clears the line
{
  const s = useStore.getState()
  s.setDoc(doc)
  const after = useStore.getState()
  assert.deepEqual(after.chat, [], 'setDoc starts a fresh chat')
  assert.equal(after.lastAgentLine, null)
  assert.equal(after.lastAgentLineAt, null)
  assert.equal(after.paragraphs.length, 2)
  assert.equal(after.currentParagraph, 0)

  s.pushChat({ id: 'a2', role: 'assistant', text: 'Reading.' })
  s.setInterim('wait')
  s.addHighlight({ id: 'h', anchor: 0, text: 'a', createdAt: 1 })
  s.clearDoc()
  const cleared = useStore.getState()
  assert.equal(cleared.doc, null)
  assert.deepEqual(cleared.paragraphs, [])
  assert.deepEqual(cleared.chat, [])
  assert.equal(cleared.interim, '')
  assert.equal(cleared.lastAgentLine, null, 'the stale line is cleared on close')
  assert.equal(cleared.lastAgentLineAt, null)
  assert.deepEqual(cleared.highlights, [])
  assert.equal(cleared.playing, false)
}

console.log('store.check.ts: ok')
