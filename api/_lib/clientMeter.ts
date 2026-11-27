// What only the browser can time, reported into the same meter as the server's
// ports: how long the narration played over the reader before it ducked
// (bargein), how long a turn handed to the model took to make a sound
// (first_audio), and how many seconds of mic audio went to the speech-input
// vendor (listen), which bills by the second and never passes this server.
//
// The body comes from anyone with the URL, so nothing in it is passed through:
// each event is rebuilt from fields checked against a short list, and a body
// with one bad event is refused whole.
import type { MeterEvent } from './ports.js'
import { record } from './meter.js'

/** The providers each browser-reported port may name. */
const PROVIDERS: Record<string, readonly string[]> = {
  bargein: ['level', 'words'],
  first_audio: ['reply', 'narration'],
  listen: ['deepgram'],
}

export const MAX_EVENTS = 50
const MAX_MS = 86_400_000 // a day: a stream reports each minute of audio, but a muted one runs on
const MAX_SECONDS = 3_600

const whole = (v: unknown, max: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max

function event(raw: unknown, client: 'web' | 'phone'): MeterEvent | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { port, provider, ms, ok, units } = raw as Record<string, unknown>
  if (typeof port !== 'string' || typeof provider !== 'string' || !PROVIDERS[port]?.includes(provider)) return null
  if (!whole(ms, MAX_MS) || typeof ok !== 'boolean') return null
  const e: MeterEvent = { port: port as MeterEvent['port'], provider, client, ms: Math.round(ms), ok }
  if (units === undefined) return e
  const seconds = (units as { seconds?: unknown } | null)?.seconds
  if (port !== 'listen' || !whole(seconds, MAX_SECONDS) || Object.keys(units as object).length !== 1) return null
  return { ...e, units: { seconds: Math.round(seconds * 10) / 10 } }
}

/** Records a POST /api/meter body. Null when every event was recorded, otherwise what to answer. */
export function recordClientEvents(body: unknown): { status: 400; error: string } | null {
  const { events, client } = (body ?? {}) as { events?: unknown; client?: unknown }
  if (!Array.isArray(events) || events.length === 0 || events.length > MAX_EVENTS)
    return { status: 400, error: `events must be 1 to ${MAX_EVENTS} items` }
  const from = client === 'phone' ? 'phone' : 'web'
  const checked = events.map((raw) => event(raw, from))
  if (checked.some((e) => e === null)) return { status: 400, error: 'unrecognised meter event' }
  for (const e of checked) record(e!)
  return null
}
