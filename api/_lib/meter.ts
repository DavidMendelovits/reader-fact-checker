// The Meter: latency and billed units for every call to an outside service, in
// one shape whichever vendor answered (MeterEvent in ./ports.ts). providers.ts
// hands out each port already wrapped here, so a new adapter is metered without
// knowing it.
//
// Each event is one log line, `[meter] {...}`, so Vercel's logs are the record
// until there is somewhere better. A replay run swaps in its own Meter to write
// rows instead; a sink that can fail guards itself.
import type { ConversationModel, Decider, JsonCompletion, Meter, MeterEvent, SearchModel, SpeechRecognizer, SpeechSynthesizer, TurnUsage } from './ports.js'

interface Rates {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/**
 * US dollars per million tokens, Anthropic's first-party prices as of Nov 2026.
 * Cache writes are the 5-minute kind, 1.25x input. Cache reads are 0.05x input
 * on the 5.5 models and 0.1x on the rest, as the price list has them.
 *
 * ponytail: tokens only, and only for conversation turns. Speech is metered in
 * characters and search and claims in time, with no cost yet (the json port
 * returns bare text, so claims' tokens aren't seen); their prices go here once their ports report usage
 * and the vendors' price pages have been read.
 */
export const PRICES: Record<string, Rates> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
}

/**
 * The table's entry for a model id, matched by the longest key it starts with,
 * so a dated id the API may answer with (claude-sonnet-5-20261001) still finds
 * claude-sonnet-5, and claude-sonnet-5-5 finds its own row, not that one.
 */
function ratesFor(model: string): Rates | undefined {
  const key = Object.keys(PRICES)
    .filter((k) => model === k || model.startsWith(`${k}-`))
    .sort((a, b) => b.length - a.length)[0]
  return key ? PRICES[key] : undefined
}

/** What a turn cost, or undefined when the model isn't in the table. */
export function tokenCost(model: string | undefined, u: TurnUsage | undefined): number | undefined {
  const r = model ? ratesFor(model) : undefined
  if (!r || !u) return undefined
  return (u.input * r.input + u.output * r.output + u.cacheRead * r.cacheRead + u.cacheWrite * r.cacheWrite) / 1e6
}

const logMeter: Meter = { record: (e) => console.log(`[meter] ${JSON.stringify(e)}`) }
let sink: Meter = logMeter

/** For tests and replay runs: send events somewhere else, or null to go back to the log. */
export function useMeter(m: Meter | null) {
  sink = m ?? logMeter
}

/** One event straight to the sink, for what isn't a call through a port (clientMeter.ts). */
export function record(e: MeterEvent) {
  sink.record(e)
}

/**
 * Time a call and record it once, whether it lands or throws. The record is made
 * outside the try, so the meter never turns a call that worked into a failure.
 */
async function timed<T>(base: Omit<MeterEvent, 'ms' | 'ok'>, call: (mark: () => void) => Promise<T>, after?: (r: T) => Partial<MeterEvent>): Promise<T> {
  const t0 = Date.now()
  let first = 0
  const mark = () => void (first ||= Date.now())
  let outcome: { ok: true; r: T } | { ok: false; e: unknown }
  try {
    outcome = { ok: true, r: await call(mark) }
  } catch (e) {
    outcome = { ok: false, e }
  }
  sink.record({
    ...base,
    ms: Date.now() - t0,
    ...(first ? { firstMs: first - t0 } : {}),
    ok: outcome.ok,
    ...(outcome.ok ? after?.(outcome.r) : {}),
  })
  if (!outcome.ok) throw outcome.e
  return outcome.r
}

export function meteredConversation(m: ConversationModel): ConversationModel {
  return {
    name: m.name,
    turn: (req, hooks = {}) =>
      timed(
        { port: 'conversation', provider: m.name },
        (mark) => m.turn(req, { ...hooks, onText: (t) => (mark(), hooks.onText?.(t)) }),
        (r) => ({ model: r.model, units: r.usage && { ...r.usage }, cost: tokenCost(r.model, r.usage) }),
      ),
  }
}

export function meteredJson(m: JsonCompletion): JsonCompletion {
  return { name: m.name, complete: (req) => timed({ port: 'json', provider: m.name }, () => m.complete(req)) }
}

export function meteredSearch(m: SearchModel): SearchModel {
  return {
    name: m.name,
    answer: (req, onDelta) =>
      timed({ port: 'search', provider: m.name }, (mark) => m.answer(req, onDelta && ((t) => (mark(), onDelta(t))))),
  }
}

/** ok means the vendor accepted the request and the audio began; a stream that breaks later isn't seen. */
export function meteredSpeech(m: SpeechSynthesizer): SpeechSynthesizer {
  return {
    name: m.name,
    mimeType: m.mimeType,
    maxChars: m.maxChars,
    synthesize: (text) => timed({ port: 'speech', provider: m.name, units: { chars: text.length } }, () => m.synthesize(text)),
  }
}

export function meteredDecider(m: Decider): Decider {
  return { name: m.name, decide: (state, questions) => timed({ port: 'decider', provider: m.name }, () => m.decide(state, questions)) }
}

// This times the grant only. The audio itself streams from the browser to the
// vendor, so the browser reports its seconds (clientMeter.ts).
export function meteredListen(m: SpeechRecognizer): SpeechRecognizer {
  return { name: m.name, grant: () => timed({ port: 'listen', provider: m.name }, () => m.grant()) }
}
