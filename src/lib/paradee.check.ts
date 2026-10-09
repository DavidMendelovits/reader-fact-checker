// Self-check for the pure half of the Paradee voice. Run it with:
//
//   node --experimental-strip-types src/lib/paradee.check.ts
//
// The model, eSpeak and onnxruntime need a browser; what is checked here is
// what the reference Python inference pins down: ids, the 510 cut, the WAV.
import assert from 'node:assert/strict'
import { KEEP_SILENCE_MS, MAX_PHONEMES, chunkPhonemes, encodeWav, normalizeText, splitSentences, toIds, trimSilence } from './paradee-core.ts'

// --- sentences: the reference regex ------------------------------------------
assert.deepEqual(splitSentences('  One. Two?  Three…\n\nFour '), ['One.', 'Two?', 'Three…', 'Four'])

// --- normalize: said, not spelled; anything date-like left alone -------------
assert.equal(
  normalizeText('Pi is roughly 22/7, e.g. 3.14, i.e. close enough.'),
  'Pi is roughly 22 over 7, for example 3.14, that is close enough.',
)
assert.equal(normalizeText('E.g. cats vs. dogs, cf. Smith, etc.'), 'For example cats versus dogs, compare Smith, etc.')
assert.equal(normalizeText('I.e. 355/113 or 3/40, open 24/7.'), 'That is 355 over 113 or 3 over 40, open 24 7.')
assert.equal(normalizeText('Half is 1/2, then 3/4, 2/3, 7/2.'), 'Half is 1 half, then 3 quarters, 2 thirds, 7 over 2.')
for (const kept of ['On 10/7/2026.', '1.5/2', 'v1/2', 'a/b', 'VS Code', 'ie. no'])
  assert.equal(normalizeText(kept), kept)

// --- ids: pad at each end, unknown phonemes dropped, at most 510 inside -------
{
  const vocab = { a: 43, b: 44, ' ': 16 }
  assert.deepEqual(toIds('a b§', vocab), [0, 43, 16, 44, 0])
  const ids = toIds('a'.repeat(600), vocab)
  assert.equal(ids.length, MAX_PHONEMES + 2)
  assert.equal(ids[0], 0)
  assert.equal(ids.at(-1), 0)
}

// --- chunks: cut at the last space that fits, no leading space on the rest ----
{
  assert.deepEqual(chunkPhonemes('short'), ['short'])
  assert.deepEqual(chunkPhonemes(''), [])
  const word = 'x'.repeat(99)
  const ps = Array(8).fill(word).join(' ') // 8 * 99 + 7 = 799
  const chunks = chunkPhonemes(ps)
  assert.equal(chunks.length, 2)
  assert.equal(chunks[0], Array(5).fill(word).join(' ')) // 499: the 6th word would end at 599
  assert.equal(chunks[1], Array(3).fill(word).join(' '))
  // no space at all: a hard cut at 510
  assert.deepEqual(chunkPhonemes('y'.repeat(1100)).map((c) => c.length), [510, 510, 80])
}

// --- trim: each end's silence cut to keepMs, quiet speech inside left alone ---
{
  const sr = 1000 // 1 sample = 1 ms
  const x = new Float32Array(1000) // 300 ms silence, 400 ms sound, 300 ms silence
  for (let i = 300; i < 700; i++) x[i] = i % 2 ? 0.5 : -0.5
  x[500] = 0 // a silent sample mid-speech is not an end
  x[50] = 0.005 // noise under the floor doesn't count as sound
  const t = trimSilence(x, sr, 120)
  assert.equal(t.length, 120 + 400 + 120)
  assert.equal(t[120], -0.5, 'speech starts after exactly 120 ms of kept silence')
  assert.equal(t[120 + 399], 0.5, 'and its last sample survives')
  // less silence than keepMs at an end: nothing to cut there
  assert.equal(trimSilence(x.subarray(250), sr, 120).length, 50 + 400 + 120)
  // all silence: unchanged rather than an empty clip
  assert.equal(trimSilence(new Float32Array(200), sr, 120).length, 200)
  assert.equal(trimSilence(new Float32Array(0), sr, 120).length, 0)
  // by default only a margin is left: the pause between clips is the player's
  assert.equal(trimSilence(x, sr).length, KEEP_SILENCE_MS + 400 + KEEP_SILENCE_MS)}

// --- WAV: 44-byte header, 16-bit mono PCM, parts concatenated ----------------
{
  const buf = encodeWav([new Float32Array([0, 1, -1]), new Float32Array([0.5, 2])], 24000)
  const v = new DataView(buf)
  const ascii = (at: number) => String.fromCharCode(...new Uint8Array(buf, at, 4))
  assert.equal(buf.byteLength, 44 + 5 * 2)
  assert.equal(ascii(0), 'RIFF')
  assert.equal(v.getUint32(4, true), 36 + 5 * 2)
  assert.equal(ascii(8), 'WAVE')
  assert.equal(ascii(12), 'fmt ')
  assert.equal(v.getUint16(20, true), 1, 'PCM')
  assert.equal(v.getUint16(22, true), 1, 'mono')
  assert.equal(v.getUint32(24, true), 24000)
  assert.equal(v.getUint32(28, true), 48000)
  assert.equal(v.getUint16(34, true), 16)
  assert.equal(ascii(36), 'data')
  assert.equal(v.getUint32(40, true), 5 * 2)
  const pcm = [0, 1, 2, 3, 4].map((k) => v.getInt16(44 + k * 2, true))
  assert.deepEqual(pcm, [0, 32767, -32768, 16383, 32767], 'scaled and clipped')
}

console.log('paradee.check: ok')
