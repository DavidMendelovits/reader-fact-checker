// Self-check for the stitched speech path (_lib/speech.ts) over the Unreal
// Speech adapter.
//
// The vendor's streaming endpoint takes 1,000 characters per call and answers
// each with a complete MP3 file, tag and all. The server has to split a paragraph
// at sentence boundaries, fetch the pieces in order, and hand the browser one
// continuous MP3 — which means exactly one ID3 tag, at the front. A fake vendor
// (a stubbed fetch, no socket) stands in for the real one so the whole pipe runs
// here, keys or no keys.
import assert from 'node:assert/strict'
import { describe, it, vi } from 'vitest'

process.env.UNREAL_SPEECH_API_KEY = 'test'
process.env.TTS_PROVIDER = 'unreal'
delete process.env.UNREAL_SPEECH_BASE_URL // the adapter's own default endpoint
const { chunkForTts: chunk, id3v2Length, ttsStream } = await import('./_lib/speech.ts')
const chunkForTts = (text: string) => chunk(text, 1000)

const s = (n: number, ch = 'a') => `${ch.repeat(n - 1)}.`

const id3 = (size: number, flags = 0) =>
  new Uint8Array([0x49, 0x44, 0x33, 4, 0, flags, (size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f])

describe('chunkForTts', () => {
  it('returns nothing for empty or blank text, and one chunk for short text', () => {
    assert.deepEqual(chunkForTts(''), [])
    assert.deepEqual(chunkForTts('   '), [])
    assert.deepEqual(chunkForTts('One. Two. Three.'), ['One. Two. Three.'])
  })

  it('packs whole sentences up to the limit, never splitting one that fits', () => {
    const chunks = chunkForTts([s(400), s(400), s(400)].join(' '))
    assert.deepEqual(chunks.map((c) => c.length), [801, 400])
    assert.ok(chunks.every((c) => c.length <= 1000))
  })

  it('cuts an oversize sentence at whitespace, as late as possible', () => {
    const words = Array.from({ length: 300 }, (_, i) => `w${i}`).join(' ') // ~1,490 chars, one sentence
    const chunks = chunkForTts(`${words}. Short one.`)
    assert.ok(chunks.length >= 2)
    assert.ok(chunks.every((c) => c.length <= 1000), 'chunk over the limit')
    // no mid-word cut: the pieces rejoin on single spaces into the original
    assert.equal(chunks.join(' '), `${words}. Short one.`)
  })

  it("normalizes whitespace so the chunk boundaries don't depend on the source's line breaks", () => {
    assert.deepEqual(chunkForTts('One.\n\nTwo.   Three.'), ['One. Two. Three.'])
  })
})

describe('id3v2Length', () => {
  it('reads the tag length from an ID3v2 header', () => {
    assert.equal(id3v2Length(new Uint8Array([0xff, 0xfb, 0x90, 0x00])), 0) // a bare MP3 frame
    assert.equal(id3v2Length(id3(0)), 10)
    assert.equal(id3v2Length(id3(35)), 45)
    assert.equal(id3v2Length(id3(35, 0x10)), 55) // footer flag adds ten bytes
    assert.equal(id3v2Length(new Uint8Array([0x49, 0x44])), 0) // too short to be a header
  })
})

describe('ttsStream over a fake vendor', () => {
  it('fetches the chunks in order and returns one MP3 with exactly one ID3 tag, at the front', async () => {
    // Each response: an ID3 tag with a 35-byte body, then a payload that names the
    // chunk, sent in two writes so the tag-stripping buffer sees a split header.
    const seen: { url: string; auth: string | null; text: string }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const { Text } = JSON.parse(String(init?.body)) as { Text: string }
        seen.push({ url: String(url), auth: new Headers(init?.headers).get('authorization'), text: Text })
        const tag = Buffer.concat([Buffer.from(id3(35)), Buffer.alloc(35, 0x54)])
        const payload = Buffer.from(`<${Text.slice(0, 12)}>`)
        const body = new ReadableStream<Uint8Array>({
          async start(out) {
            out.enqueue(new Uint8Array(tag.subarray(0, 6))) // half a header
            await new Promise((r) => setTimeout(r, 20))
            out.enqueue(new Uint8Array(Buffer.concat([tag.subarray(6), payload])))
            out.close()
          },
        })
        return new Response(body, { status: 200, headers: { 'Content-Type': 'audio/mpeg' } })
      }),
    )

    const text = [s(600, 'a'), s(600, 'b'), s(600, 'c')].join(' ')
    const res = await ttsStream(text)
    assert.equal(res.headers.get('Content-Type'), 'audio/mpeg')
    const out = Buffer.from(await res.arrayBuffer())

    // what the vendor was sent
    assert.ok(seen.every((r) => r.url === 'https://api.v8.unrealspeech.com/stream'), 'wrong vendor URL')
    assert.ok(seen.every((r) => r.text.length <= 1000), `vendor got ${Math.max(...seen.map((r) => r.text.length))} chars`)
    assert.ok(seen.every((r) => r.auth === 'Bearer test'), 'missing or wrong bearer key')
    assert.deepEqual(seen.map((r) => r.text[0]), ['a', 'b', 'c'], 'chunks requested out of order')
    // exactly one tag, at the front
    assert.equal(id3v2Length(out.subarray(0, 10)), 45)
    assert.equal(out.indexOf('ID3', 3), -1, 'a later chunk kept its ID3 tag')
    // payloads in order, back to back after the one tag
    assert.equal(out.subarray(45).toString(), `<${'a'.repeat(12)}><${'b'.repeat(12)}><${'c'.repeat(12)}>`)
  })
})
