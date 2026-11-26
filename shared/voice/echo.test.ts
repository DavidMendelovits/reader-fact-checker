// Tests for the echo filter, the one piece of the listeners with logic worth
// pinning down (both listeners import it from here).
//
// The regression it exists for: scoring `heard` against the whole of `spoken` as a
// bag of words makes the denominator every word recently narrated, and any English
// sentence overlaps a few paragraphs of English by more than half on function words
// alone. Real speech read as echo, so barge-in never fired and the book read
// straight over the user. Every "real speech" case below was rejected by that
// version. Windowing is what fixes it — keep these passing.
import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { isEcho, stripEcho } from './echo.ts'

// what getRecentSpokenText() returns mid-narration: a few paragraphs' worth
const NARRATION =
  'He was born on the steppe and by the time he was a grown man he had united ' +
  'the tribes that had spent generations at war with one another. What he built ' +
  'was not just an army but a system of roads and messengers that carried word ' +
  'across the continent faster than anything the world had seen before it. ' +
  'The empire that came out of this was the largest the world would ever see, ' +
  'and what it did to the places it touched is still argued about today. Was it ' +
  'a catastrophe, or was it the thing that finally connected east and west? Ask ' +
  'a historian in one country and you will get an answer that a historian in ' +
  'another would not recognise at all.'

describe('isEcho', () => {
  it('real speech over the narration all reaches the agent', () => {
    for (const heard of [
      'what was that',
      'wait what was that',
      'was that actually true',
      'go back to the part about the messengers',
      'what did he say about the tribes',
      'is that really what happened or is it just a story',
      'hold on what was the thing about the roads',
      'go back a bit',
      'keep going',
    ]) {
      assert.equal(isEcho(heard, NARRATION), false, `swallowed real speech: ${heard}`)
    }
  })

  it('the recognizer transcribing the narration out of the speakers is dropped', () => {
    for (const heard of [
      'was not just an army but a system of roads and messengers',
      'the tribes that had spent generations at war with one another',
      'at war with one another',
      // near-verbatim: recognition mishears a word or two and it still counts
      'was not just an army but a system of rhodes and messengers',
    ]) {
      assert.equal(isEcho(heard, NARRATION), true, `leaked an echo: ${heard}`)
    }
  })

  // This case now carries real weight: the mic used to be muted outright while the
  // agent spoke, which threw away anything the recognizer finalized in that window —
  // whole sentences went missing and barging in over a reply was impossible. isEcho
  // is the only guard left, so it has to hold on the agent's short replies too.
  it("the agent's own reply is dropped, which is what showed up as a user turn in the bug report", () => {
    const REPLY = "That's exactly what we're doing — let's get into it."
    assert.equal(isEcho("that's exactly what we're doing let's get into it", REPLY), true)

    for (const [heard, reply] of [
      ['let me check that', 'Let me check that.'],
      ['sure picking up from where we left off', "Sure — picking up from where we left off."],
      ['the claim holds up the figure is about right', 'The claim holds up. The figure is about right.'],
      // a fragment of the reply, caught mid-sentence
      ['picking up from where', "Sure — picking up from where we left off."],
    ] as const) {
      assert.equal(isEcho(heard, reply), true, `leaked the agent's own reply: ${heard}`)
    }
  })

  it('a barge-in over that same reply still gets through', () => {
    for (const [heard, reply] of [
      ['stop', 'Let me check that.'],
      ['no i meant the other one', 'Let me check that.'],
      ['what', "Sure — picking up from where we left off."],
      ['go back to chapter two', 'The claim holds up. The figure is about right.'],
    ] as const) {
      assert.equal(isEcho(heard, reply), false, `swallowed a barge-in: ${heard}`)
    }
  })

  it('nothing playing means nothing to echo', () => {
    assert.equal(isEcho('pause', ''), false)
  })
})

// keep the barge-in that arrived glued to a mouthful of narration
describe('stripEcho', () => {
  it("all narration leaves nothing of the user's, and one surviving word is dropped too", () => {
    assert.equal(stripEcho('the tribes that had spent generations at war with one another', NARRATION), null)
    // one surviving word is as likely a stray from the book as a command
    assert.equal(stripEcho('at war', NARRATION), null)
  })

  // the case this exists for: isEcho drops the whole line; this keeps the command.
  it('keeps the command when the recognizer merged the tail of a paragraph with the interruption', () => {
    {
      const rest = stripEcho('was not just an army but a system of roads and messengers stop the book', NARRATION)
      assert.ok(rest, 'dropped a barge-in glued to an echo')
      assert.ok(rest.includes('stop'), `lost the command: ${rest}`)
      assert.ok(rest.includes('book'), `lost the command: ${rest}`)
      assert.ok(!rest.includes('messengers'), `kept the narration: ${rest}`)
      assert.ok(!rest.includes('army'), `kept the narration: ${rest}`)
    }
    {
      const rest = stripEcho('at war with one another go back to the hemingway', NARRATION)
      assert.ok(rest, 'dropped a barge-in glued to an echo')
      assert.ok(rest.includes('hemingway'), `lost the command: ${rest}`)
      // ponytail: set subtraction, so a word the window happened to miss ('another')
      // rides along. Harmless — the agent normalizes and the command is intact.
      assert.ok(!rest.includes('war'), `kept the narration: ${rest}`)
    }
  })

  it("the agent's own reply, same story", () => {
    const rest = stripEcho('let me check that no i meant the other one', 'Let me check that.')
    assert.ok(rest, "dropped a barge-in over the agent's reply")
    assert.ok(rest.includes('meant'), rest)
    assert.ok(!rest.includes('check'), rest)
  })

  it('nothing playing means nothing to strip, and clean speech survives whole', () => {
    assert.equal(stripEcho('pause the book', ''), 'pause the book')
    assert.equal(stripEcho('open the hemingway one', 'Let me check that.'), 'open the hemingway one')
  })
})
