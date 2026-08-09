// TTS via our server endpoint (/api/tts → OpenAI), with per-paragraph synthesis,
// prefetch, and a simple playback queue. Position unit = flat paragraph index (see store).
import { apiFetch } from './api'
import { attachOutput } from './audio-levels'

const blobCache = new Map<string, Promise<string>>() // cacheKey -> object URL

// Chrome streams MP3 into MediaSource fine; anything else falls back to buffering.
const CAN_STREAM =
  typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported('audio/mpeg')

function fetchAudio(text: string, signal?: AbortSignal) {
  return apiFetch('/api/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
    signal,
  })
}

async function synthesize(text: string): Promise<string> {
  const res = await fetchAudio(text)
  if (!res.ok) throw new Error(`TTS failed (${res.status}): ${await res.text()}`)
  return URL.createObjectURL(await res.blob())
}

function getAudioUrl(key: string, text: string): Promise<string> {
  let p = blobCache.get(key)
  if (!p) {
    p = synthesize(text)
    p.catch(() => blobCache.delete(key)) // allow retry after failure
    blobCache.set(key, p)
  }
  return p
}

/**
 * Point `audio` at a MediaSource fed by the response stream, so playback starts on
 * the first chunk instead of waiting for the whole clip. Resolves once the element
 * is wired up — not when playback ends.
 *
 * Synthesis runs far ahead of playback (~5s to generate ~30s of speech), so
 * underruns aren't a practical concern.
 */
async function attachStream(
  audio: HTMLAudioElement,
  text: string,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetchAudio(text, signal)
  if (!res.ok) throw new Error(`TTS failed (${res.status}): ${await res.text()}`)
  const body = res.body
  if (!body) throw new Error('TTS returned no body')

  const source = new MediaSource()
  audio.src = URL.createObjectURL(source)
  await new Promise<void>((resolve) =>
    source.addEventListener('sourceopen', () => resolve(), { once: true }),
  )

  const buffer = source.addSourceBuffer('audio/mpeg')
  const queue: Uint8Array[] = []
  let finished = false
  const pump = () => {
    if (buffer.updating) return
    const next = queue.shift()
    if (next) buffer.appendBuffer(next as BufferSource)
    else if (finished && source.readyState === 'open') source.endOfStream()
  }
  buffer.addEventListener('updateend', pump)

  // drain in the background; playback proceeds as chunks land
  void (async () => {
    const reader = body.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        queue.push(value)
        pump()
      }
    } catch {
      /* aborted or network error — endOfStream below leaves what we have playable */
    } finally {
      finished = true
      pump()
    }
  })()
}

export class TtsPlayer {
  private audio = new Audio()
  private session = 0 // bumped to cancel in-flight playback loops
  onParagraphChange: (index: number) => void = () => {}
  onEnded: () => void = () => {}
  onSpeakingChange: (speaking: boolean) => void = () => {}
  /**
   * Fires whenever *document narration* starts or stops, from any caller — manual
   * Play, the agent's read_aloud, a fast-path resume, or a pause that cut any of
   * them short. The header's Play/Pause button reads this, so the player has to own
   * it: every place that used to flip `playing` by hand eventually drifted.
   */
  onPlayingChange: (playing: boolean) => void = () => {}

  private paragraphs: string[] = []
  private index = 0
  rate = 1
  /** Text currently coming out of the speaker — the echo filter matches against it. */
  speaking = ''
  private streamAbort: AbortController | null = null
  private narrating = false
  // Resolves the paragraph currently awaited in playFrom. A paused <audio> never
  // fires 'ended', so without this an interruption left read_aloud hanging forever.
  private interrupt: (() => void) | null = null

  setParagraphs(paragraphs: string[]) {
    this.paragraphs = paragraphs
  }

  get currentIndex() {
    return this.index
  }

  private setNarrating(on: boolean) {
    if (this.narrating === on) return
    this.narrating = on
    this.onPlayingChange(on)
  }

  /**
   * Read paragraphs [index, until] aloud. Resolves 'completed' when the range
   * finishes, or 'stopped' if pause() cancelled it (the agent's read_aloud tool
   * distinguishes the two — 'stopped' means the user talked over it).
   */
  async playFrom(index: number, until = Infinity): Promise<'completed' | 'stopped'> {
    const session = ++this.session
    const last = Math.min(until, this.paragraphs.length - 1)
    this.index = index
    this.setNarrating(true)
    try {
      return await this.runRange(index, last, session)
    } finally {
      // only clear if we're still the live session — a barge-in that immediately
      // started a new range must not be flipped back off by the old one unwinding
      if (session === this.session) this.setNarrating(false)
    }
  }

  private async runRange(index: number, last: number, session: number): Promise<'completed' | 'stopped'> {
    this.index = index
    while (this.index <= last && session === this.session) {
      const i = this.index
      this.onParagraphChange(i)
      // Prefetch two ahead. One was enough when every paragraph cost a full
      // synthesis wait; now that the current one streams, a deeper queue is what
      // keeps the *gaps* between paragraphs at zero.
      for (const n of [i + 1, i + 2]) {
        if (n <= last) void getAudioUrl(`p${n}`, this.paragraphs[n]).catch(() => {})
      }
      try {
        this.speaking = this.paragraphs[i]
        await this.playParagraph(i, session)
        if (session !== this.session) return 'stopped'
      } catch (e) {
        console.error('TTS error, skipping paragraph', i, e)
      } finally {
        this.speaking = ''
      }
      if (session !== this.session) return 'stopped'
      this.index = i + 1
    }
    if (session !== this.session) return 'stopped'
    this.onEnded()
    return 'completed'
  }

  /**
   * Prefetched paragraphs play instantly from cache; an uncached one (the first
   * after Play, or after an interruption) streams so audio starts on the first
   * chunk rather than after the whole clip synthesizes.
   */
  private async playParagraph(i: number, session: number): Promise<void> {
    const key = `p${i}`
    const text = this.paragraphs[i]
    if (blobCache.has(key) || !CAN_STREAM) {
      const url = await getAudioUrl(key, text)
      if (session !== this.session) return
      return this.playUrl(url, session)
    }
    return this.playStreamed(text, session)
  }

  private playStreamed(text: string, session: number): Promise<void> {
    void attachOutput(this.audio)
    // Interrupting mid-paragraph must kill the download too, or every barge-in
    // leaves a stream draining in the background and burns TTS credits.
    this.streamAbort?.abort()
    const abort = new AbortController()
    this.streamAbort = abort
    return new Promise((resolve) => {
      this.interrupt = resolve
      attachStream(this.audio, text, abort.signal).then(
        () => {
          if (session !== this.session) {
            this.audio.pause()
            return resolve()
          }
          this.audio.playbackRate = this.rate
          this.audio.onended = () => resolve()
          this.audio.onerror = () => resolve()
          this.audio.play().catch(() => resolve())
        },
        (e) => {
          console.error('TTS stream failed', e)
          resolve()
        },
      )
    })
  }

  private playUrl(url: string, session: number): Promise<void> {
    void attachOutput(this.audio) // idempotent; no-op if WebAudio isn't usable
    return new Promise((resolve) => {
      this.interrupt = resolve
      this.audio.src = url
      this.audio.playbackRate = this.rate
      this.audio.onended = () => resolve()
      this.audio.onerror = () => resolve()
      this.audio.play().catch(() => resolve())
      // safety: if session was cancelled while awaiting play
      if (session !== this.session) {
        this.audio.pause()
        resolve()
      }
    })
  }

  pause() {
    this.session++ // cancels the loop
    this.streamAbort?.abort()
    this.streamAbort = null
    this.audio.pause()
    this.interrupt?.()
    this.interrupt = null
    this.setNarrating(false)
  }

  setRate(rate: number) {
    this.rate = rate
    this.audio.playbackRate = rate
  }

  clearCacheForNewDoc() {
    blobCache.clear()
  }

  /** Speak arbitrary text (fact-check verdicts) outside the paragraph loop. */
  async speak(text: string): Promise<void> {
    this.pause()
    this.onSpeakingChange(true)
    void attachOutput(this.audio)
    try {
      this.speaking = text
      // the agent's own replies are never prefetchable, so always stream them
      await this.playStreamed(text, this.session)
    } finally {
      this.speaking = ''
      this.onSpeakingChange(false)
    }
  }
}

export const tts = new TtsPlayer()
