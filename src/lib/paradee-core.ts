// The platform-free half of the Paradee voice (paradee.ts): text -> chunks of
// phonemes -> token ids, and float samples -> a WAV file. No onnxruntime, no
// eSpeak, so paradee.check.ts runs it under node --experimental-strip-types.
//
// Follows the reference Python inference (paradee/tts.py in
// github.com/sahilmahendrakar/paradee) step for step.

export const SAMPLE_RATE = 24000
/** The text side has 512 positions, two of which are the pad tokens at each end. */
export const MAX_PHONEMES = 510

/** Long text is read one sentence at a time. */
export function splitSentences(text: string): string[] {
  return text
    .trim()
    .split(/(?<=[.!?…])\s+|\n+/)
    .filter((s) => s.trim())
}

/** A sentence whose phonemes don't fit is cut at the last space that does. */
export function chunkPhonemes(ps: string): string[] {
  const out: string[] = []
  while (ps.length > MAX_PHONEMES) {
    const space = ps.lastIndexOf(' ', MAX_PHONEMES - 1)
    const cut = space > 0 ? space : MAX_PHONEMES
    out.push(ps.slice(0, cut))
    ps = ps.slice(cut).trimStart()
  }
  if (ps) out.push(ps)
  return out
}

/** Phonemes the vocab doesn't know are dropped; a 0 pad token goes at each end. */
export function toIds(ps: string, vocab: Record<string, number>): number[] {
  const ids = [...ps].filter((c) => Object.hasOwn(vocab, c)).map((c) => vocab[c])
  return [0, ...ids.slice(0, MAX_PHONEMES), 0]
}

/** 16-bit mono PCM WAV of the concatenated parts. */
export function encodeWav(parts: Float32Array[], sampleRate: number): ArrayBuffer {
  const n = parts.reduce((sum, p) => sum + p.length, 0)
  const buf = new ArrayBuffer(44 + n * 2)
  const v = new DataView(buf)
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i))
  }
  ascii(0, 'RIFF')
  v.setUint32(4, 36 + n * 2, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  v.setUint32(16, 16, true) // fmt chunk size
  v.setUint16(20, 1, true) // PCM
  v.setUint16(22, 1, true) // mono
  v.setUint32(24, sampleRate, true)
  v.setUint32(28, sampleRate * 2, true) // byte rate
  v.setUint16(32, 2, true) // block align
  v.setUint16(34, 16, true) // bits per sample
  ascii(36, 'data')
  v.setUint32(40, n * 2, true)
  let at = 44
  for (const p of parts) {
    for (const x of p) {
      const s = Math.max(-1, Math.min(1, x))
      v.setInt16(at, s < 0 ? s * 0x8000 : s * 0x7fff, true)
      at += 2
    }
  }
  return buf
}
