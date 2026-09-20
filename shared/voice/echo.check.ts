// Self-check for the echo filter — the one piece of voice.ts with logic worth
// pinning down. Run it with:
//
//   node --experimental-strip-types src/lib/voice.check.ts
//
// The regression it exists for: scoring `heard` against the whole of `spoken` as a
// bag of words makes the denominator every word recently narrated, and any English
// sentence overlaps a few paragraphs of English by more than half on function words
// alone. Real speech read as echo, so barge-in never fired and the book read
// straight over the user. Every "real speech" case below was rejected by that
// version. Windowing is what fixes it — keep these passing.
import assert from 'node:assert/strict'
import { isEcho } from './voice.ts'

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

// real speech over the narration — all of this has to reach the agent
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

// the recognizer transcribing the narration out of the speakers — has to be dropped
for (const heard of [
  'was not just an army but a system of roads and messengers',
  'the tribes that had spent generations at war with one another',
  'at war with one another',
  // near-verbatim: recognition mishears a word or two and it still counts
  'was not just an army but a system of rhodes and messengers',
]) {
  assert.equal(isEcho(heard, NARRATION), true, `leaked an echo: ${heard}`)
}

// The agent's own reply, which is what showed up as a user turn in the bug report.
// This case now carries real weight: the mic used to be muted outright while the
// agent spoke, which threw away anything the recognizer finalized in that window —
// whole sentences went missing and barging in over a reply was impossible. isEcho
// is the only guard left, so it has to hold on the agent's short replies too.
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

// ...while a barge-in over that same reply still gets through
for (const [heard, reply] of [
  ['stop', 'Let me check that.'],
  ['no i meant the other one', 'Let me check that.'],
  ['what', "Sure — picking up from where we left off."],
  ['go back to chapter two', 'The claim holds up. The figure is about right.'],
] as const) {
  assert.equal(isEcho(heard, reply), false, `swallowed a barge-in: ${heard}`)
}

// nothing playing means nothing to echo
assert.equal(isEcho('pause', ''), false)

console.log('isEcho: ok')
