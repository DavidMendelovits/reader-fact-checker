// Self-check for the Unreal Speech path in _impl.ts. Run it with:
//
//   node --experimental-strip-types api/tts.check.ts
//
// The vendor's streaming endpoint takes 1,000 characters per call and answers
// each with a complete MP3 file, tag and all. The server has to split a paragraph
// at sentence boundaries, fetch the pieces in order, and hand the browser one
// continuous MP3 — which means exactly one ID3 tag, at the front. A fake vendor
// stands in for the real one so the whole pipe runs here, keys or no keys.
import assert from 'node:assert/strict'
import http from 'node:http'

process.env.UNREAL_SPEECH_API_KEY = 'test'
process.env.TTS_PROVIDER = 'unreal'
const { chunkForTts, id3v2Length, ttsStream } = await import('./_impl.ts')

// ---- chunking ----

const s = (n: number, ch = 'a') => `${ch.repeat(n - 1)}.`

assert.deepEqual(chunkForTts(''), [])
assert.deepEqual(chunkForTts('   '), [])
assert.deepEqual(chunkForTts('One. Two. Three.'), ['One. Two. Three.'])

// packs whole sentences up to the limit, never splitting one that fits
{
  const chunks = chunkForTts([s(400), s(400), s(400)].join(' '))
  assert.deepEqual(chunks.map((c) => c.length), [801, 400])
  assert.ok(chunks.every((c) => c.length <= 1000))
}

// an oversize sentence is cut at whitespace, as late as possible
{
  const words = Array.from({ length: 300 }, (_, i) => `w${i}`).join(' ') // ~1,490 chars, one sentence
  const chunks = chunkForTts(`${words}. Short one.`)
  assert.ok(chunks.length >= 2)
  assert.ok(chunks.every((c) => c.length <= 1000), 'chunk over the limit')
  // no mid-word cut: the pieces rejoin on single spaces into the original
  assert.equal(chunks.join(' '), `${words}. Short one.`)
}

// whitespace is normalized so the chunk boundaries don't depend on the source's line breaks
assert.deepEqual(chunkForTts('One.\n\nTwo.   Three.'), ['One. Two. Three.'])

// ---- ID3v2 tag length ----

const id3 = (size: number, flags = 0) =>
  new Uint8Array([0x49, 0x44, 0x33, 4, 0, flags, (size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f])
assert.equal(id3v2Length(new Uint8Array([0xff, 0xfb, 0x90, 0x00])), 0) // a bare MP3 frame
assert.equal(id3v2Length(id3(0)), 10)
assert.equal(id3v2Length(id3(35)), 45)
assert.equal(id3v2Length(id3(35, 0x10)), 55) // footer flag adds ten bytes
assert.equal(id3v2Length(new Uint8Array([0x49, 0x44])), 0) // too short to be a header

// ---- the whole pipe, against a fake vendor ----

// Each response: an ID3 tag with a 35-byte body, then a payload that names the
// chunk, sent in two writes so the tag-stripping buffer sees a split header.
const seen: string[] = []
const fake = http.createServer(async (req, res) => {
  let body = ''
  for await (const c of req) body += c
  const { Text } = JSON.parse(body) as { Text: string }
  seen.push(Text)
  assert.ok(Text.length <= 1000, `vendor got ${Text.length} chars`)
  assert.equal(req.headers.authorization, 'Bearer test')
  res.writeHead(200, { 'Content-Type': 'audio/mpeg' })
  const tag = Buffer.concat([Buffer.from(id3(35)), Buffer.alloc(35, 0x54)])
  const payload = Buffer.from(`<${Text.slice(0, 12)}>`)
  res.write(tag.subarray(0, 6)) // half a header
  await new Promise((r) => setTimeout(r, 20))
  res.write(Buffer.concat([tag.subarray(6), payload]))
  res.end()
})
await new Promise<void>((r) => fake.listen(0, r))
process.env.UNREAL_SPEECH_BASE_URL = `http://localhost:${(fake.address() as { port: number }).port}`

const text = [s(600, 'a'), s(600, 'b'), s(600, 'c')].join(' ')
const res = await ttsStream(text)
assert.equal(res.headers.get('Content-Type'), 'audio/mpeg')
const out = Buffer.from(await res.arrayBuffer())
fake.close()

assert.deepEqual(seen.map((t) => t[0]), ['a', 'b', 'c'], 'chunks requested out of order')
// exactly one tag, at the front
assert.equal(id3v2Length(out.subarray(0, 10)), 45)
assert.equal(out.indexOf('ID3', 3), -1, 'a later chunk kept its ID3 tag')
// payloads in order, back to back after the one tag
assert.equal(out.subarray(45).toString(), `<${'a'.repeat(12)}><${'b'.repeat(12)}><${'c'.repeat(12)}>`)

console.log('tts.check: ok')
