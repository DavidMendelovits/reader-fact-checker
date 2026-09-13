// The /api/tts use-case, and the one piece of vendor-independent audio logic:
// stitching. Some vendors cap the text per request well below a paragraph of a
// book. `stitched()` wraps any MP3 synthesizer so the caller can send a whole
// paragraph and get one continuous stream back, whatever the cap.
import type { AudioStream, SpeechSynthesizer } from './ports.js'
import { providers } from './providers.js'

const TTS_MAX_CHARS = 12000 // a runaway paragraph should not become a runaway bill

export async function ttsStream(text: string): Promise<Response> {
  const synth = stitched(providers().speech)
  const started = Date.now()
  const { mimeType, body } = await synth.synthesize(text.slice(0, TTS_MAX_CHARS))
  console.log(`[tts] provider=${synth.name} chars=${text.length} first_byte=${Date.now() - started}ms`)
  return new Response(body, { headers: { 'Content-Type': mimeType } })
}

/**
 * Pack sentences into chunks of at most `max` characters. A sentence that is
 * itself too long is cut at the last whitespace that fits, so nothing is ever
 * split mid-word.
 */
export function chunkForTts(text: string, max: number): string[] {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (!clean) return []
  // split after sentence-final punctuation followed by a space
  const sentences = clean.split(/(?<=[.!?…]["'”’)\]]*)\s+/)
  const out: string[] = []
  let cur = ''
  const flush = () => {
    if (cur) out.push(cur)
    cur = ''
  }
  for (const s of sentences) {
    if (s.length > max) {
      // oversize sentence: cut at whitespace, as late as possible
      flush()
      let rest = s
      while (rest.length > max) {
        const cut = rest.lastIndexOf(' ', max)
        const at = cut > 0 ? cut : max
        out.push(rest.slice(0, at).trim())
        rest = rest.slice(at).trim()
      }
      cur = rest
      continue
    }
    if (cur && cur.length + 1 + s.length > max) flush()
    cur = cur ? `${cur} ${s}` : s
  }
  flush()
  return out
}

/**
 * Length of an ID3v2 tag at the start of `head`, or 0 if there is none. Every
 * chunk from a vendor arrives as a complete MP3 file with its own tag; the
 * browser's MP3 demuxer only tolerates one, at the very beginning.
 */
export function id3v2Length(head: Uint8Array): number {
  if (head.length < 10 || head[0] !== 0x49 || head[1] !== 0x44 || head[2] !== 0x33) return 0
  const size = ((head[6] & 0x7f) << 21) | ((head[7] & 0x7f) << 14) | ((head[8] & 0x7f) << 7) | (head[9] & 0x7f)
  const footer = head[5] & 0x10 ? 10 : 0
  return 10 + size + footer
}

/**
 * Copy `body` into `out`, dropping a leading ID3v2 tag when `stripTag` is set.
 * The tag header is ten bytes, so buffer until that much has arrived before
 * deciding; the chunks after that pass straight through.
 */
async function pipeMp3(body: ReadableStream<Uint8Array>, out: ReadableStreamDefaultController<Uint8Array>, stripTag: boolean) {
  const reader = body.getReader()
  let pending: Uint8Array | null = stripTag ? new Uint8Array(0) : null
  let skip = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    let buf = value
    if (pending) {
      const joined = new Uint8Array(pending.length + buf.length)
      joined.set(pending)
      joined.set(buf, pending.length)
      if (joined.length < 10) {
        pending = joined
        continue
      }
      skip = id3v2Length(joined)
      pending = null
      buf = joined
    }
    if (skip > 0) {
      const drop = Math.min(skip, buf.length)
      skip -= drop
      buf = buf.subarray(drop)
    }
    if (buf.length > 0) out.enqueue(buf)
  }
  if (pending && pending.length > 0) out.enqueue(pending) // shorter than a tag header: not one
}

/**
 * A synthesizer that accepts text of any length by splitting it at sentence
 * boundaries to fit the wrapped vendor's `maxChars`, fetching the pieces in
 * order with one in flight ahead of the one being sent, and piping them back
 * as a single MP3. A vendor with no cap passes straight through.
 */
export function stitched(inner: SpeechSynthesizer): SpeechSynthesizer {
  if (inner.maxChars == null) return inner
  const max = inner.maxChars
  return {
    name: inner.name,
    mimeType: inner.mimeType,
    maxChars: null,

    async synthesize(text: string): Promise<AudioStream> {
      const chunks = chunkForTts(text, max)
      if (chunks.length === 0) throw new Error('Nothing to say')
      if (chunks.length === 1) return inner.synthesize(chunks[0])

      // The first request is awaited here so a vendor error surfaces as a proper
      // status code; the rest stream behind it, always one fetch ahead of the
      // pipe. A prefetch that fails while the previous chunk is still piping
      // would be an unhandled rejection until the loop reaches it — which Node
      // treats as fatal — so each one gets a no-op handler; the `await` below
      // still sees the error.
      const prefetch = (i: number) => {
        const p = inner.synthesize(chunks[i])
        p.catch(() => {})
        return p
      }
      let next = prefetch(0)
      const first = await next
      const body = new ReadableStream<Uint8Array>({
        async start(out) {
          try {
            for (let i = 0; i < chunks.length; i++) {
              const res = i === 0 ? first : await next
              if (i + 1 < chunks.length) next = prefetch(i + 1)
              await pipeMp3(res.body, out, i > 0)
            }
            out.close()
          } catch (e) {
            console.error(`[tts] ${inner.name} stitched stream failed`, e)
            out.error(e)
          }
        },
      })
      return { mimeType: inner.mimeType, body }
    },
  }
}
