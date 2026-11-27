// What only the browser can time, batched to /api/meter, where the server logs
// it as [meter] lines beside its own ports (api/_lib/clientMeter.ts):
//
//   bargein      how long the narration played over the reader before it ducked,
//                and whether words followed (shared/voice/bargeIn.ts)
//   first_audio  from handing a turn to the model to the first sound back
//   listen       seconds of mic audio streamed to the speech-input vendor
//
// Losing a batch costs nothing but a number, so nothing here retries or asks
// for the access code: a refused send is dropped.

import { sendQuietly } from './api.ts'
import type { BargeIn } from '../../shared/voice/bargeIn.ts'

export type ClientEvent =
  | { port: 'bargein'; provider: BargeIn['path']; ms: number; ok: boolean }
  | { port: 'first_audio'; provider: 'reply' | 'narration'; ms: number; ok: true }
  | { port: 'listen'; provider: 'deepgram'; ms: number; ok: boolean; units: { seconds: number } }

const BATCH = 20 // the server takes 50
const FLUSH_MS = 30_000

export class ClientMeter {
  private queue: ClientEvent[] = []
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private send: (events: ClientEvent[]) => void = (events) => sendQuietly('/api/meter', { client: 'web', events })) {}

  record(e: ClientEvent) {
    this.queue.push(e)
    if (this.queue.length >= BATCH) this.flush()
    else this.timer ??= setTimeout(() => this.flush(), FLUSH_MS)
  }

  /** Send what's queued now: the batch is full, the timer ran out, or the page is going away. */
  flush() {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    if (this.queue.length === 0) return
    const events = this.queue
    this.queue = []
    this.send(events)
  }
}

/**
 * Time from a turn handed to the model to the first sound after it, the reply
 * or the narration the turn started.
 *
 * ponytail: a turn the model answers in silence leaves the clock running, so
 * the next sound within the cap is put down to it. The cap keeps that rare one
 * from reading as a long wait; telling a silent turn apart needs the loop to say
 * when a turn ends.
 */
export class FirstAudio {
  private handedAt: number | null = null

  constructor(
    private now: () => number = () => Date.now(),
    private capMs = 20_000,
  ) {}

  handedOff() {
    this.handedAt = this.now()
  }

  /** The first sound after a hand-off is an event; any other is not. */
  audio(kind: 'reply' | 'narration'): ClientEvent | null {
    if (this.handedAt === null) return null
    const ms = this.now() - this.handedAt
    this.handedAt = null
    return ms <= this.capMs ? { port: 'first_audio', provider: kind, ms, ok: true } : null
  }
}

export const clientMeter = new ClientMeter()
export const firstAudio = new FirstAudio()

if (typeof window !== 'undefined') {
  // the last batch rides the page's way out; keepalive lets it outlive the tab
  window.addEventListener('pagehide', () => clientMeter.flush())
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') clientMeter.flush()
  })
}
