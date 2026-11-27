// One replay run: every command in the corpus through the conversation port as
// the web app would send it, then the first chapter through the speech port, and
// the numbers from the Meter (api/_lib/meter.ts) folded into one CSV row.
//
// It calls whatever providers() picks from env, so the same run measures any
// combination of vendors and doubles as a regression check when one ships a new
// model. The entry point that spends money is run.replay.ts; this file only runs.
//
// ponytail: text in, not audio. The corpus is typed commands, so this measures
// the agent and the voice but not the ear (word errors, end of turn) or barge-in,
// which happen in the browser. Those need recorded audio through a fake mic and
// client meter events; the plan's "how often you had to repeat yourself" with them.
import { agentTurn } from '../../api/_lib/agent.ts'
import { useMeter } from '../../api/_lib/meter.ts'
import type { MeterEvent } from '../../api/_lib/ports.ts'
import { providers } from '../../api/_lib/providers.ts'
import { CHAPTERS, CONTEXT, PARAGRAPHS } from './book.ts'
import { percentile, score, type Command, type Row, type Verdict } from './score.ts'

export interface Miss {
  say: string
  verdict: Verdict
  /** What came back, in short: each tool call with its arguments, or the words. */
  got: string
  error?: string
}

export interface Options {
  commands: Command[]
  label?: string
  /** How many paragraphs to send to the speech port for reading start; 0 skips it. */
  readingParagraphs?: number
  now?: () => Date
}

const round = (n: number | undefined, places = 0) => (n === undefined ? undefined : Number(n.toFixed(places)))

/** Time to the first audio bytes, then hang up: the rest of the file isn't needed to know that. */
async function firstAudioMs(text: string): Promise<number> {
  const t0 = performance.now()
  const audio = await providers().speech.synthesize(text)
  const reader = audio.body.getReader()
  await reader.read()
  const ms = performance.now() - t0
  await reader.cancel().catch(() => {})
  return ms
}

export async function runReplay(opts: Options): Promise<{ row: Row; misses: Miss[] }> {
  const events: MeterEvent[] = []
  useMeter({ record: (e) => events.push(e) })
  const misses: Miss[] = []
  let toolOk = 0
  let argsOk = 0
  let errors = 0
  const replyText: number[] = []
  const turns: number[] = []
  const reading: number[] = []
  try {
    // one at a time, so one call's latency isn't another's queue
    for (const command of opts.commands) {
      const seen = events.length
      try {
        const { content } = await agentTurn([{ role: 'user', content: command.say }], CONTEXT, undefined, undefined, 'web')
        const verdict = score(command, content)
        toolOk += Number(verdict.tool)
        argsOk += Number(verdict.args)
        if (!verdict.args) {
          const got = content
            .map((b) => (b.type === 'tool_use' ? `${b.name}(${JSON.stringify(b.input)})` : b.type === 'text' ? JSON.stringify(b.text) : b.type))
            .join(' ')
          misses.push({ say: command.say, verdict, got: got || '(nothing)' })
        }
      } catch (e) {
        errors++
        misses.push({ say: command.say, verdict: { tool: false, args: false }, got: '', error: e instanceof Error ? e.message : String(e) })
      }
      const turn = events.slice(seen).find((e) => e.port === 'conversation' && e.ok)
      if (turn) {
        turns.push(turn.ms)
        if (turn.firstMs !== undefined) replyText.push(turn.firstMs)
      }
    }
    const count = opts.readingParagraphs ?? CHAPTERS[1].startsAt
    for (const text of PARAGRAPHS.slice(0, count)) {
      try {
        reading.push(await firstAudioMs(text))
      } catch {
        errors++
      }
    }
  } finally {
    useMeter(null)
  }

  const conv = events.filter((e) => e.port === 'conversation')
  const costs = conv.filter((e) => e.ok).map((e) => e.cost) // a failed call bills nothing we can see
  const n = opts.commands.length
  const p = providers()
  const row: Row = {
    when: (opts.now?.() ?? new Date()).toISOString(),
    label: opts.label ?? '',
    conversation: p.conversation.name,
    model: conv.find((e) => e.model)?.model ?? process.env.AGENT_MODEL ?? '',
    speech: p.speech.name,
    commands: n,
    tool_accuracy: round(n ? toolOk / n : 0, 3)!,
    args_accuracy: round(n ? argsOk / n : 0, 3)!,
    reply_text_p50_ms: round(percentile(replyText, 50)),
    reply_text_p95_ms: round(percentile(replyText, 95)),
    turn_p50_ms: round(percentile(turns, 50)),
    reading_start_p50_ms: round(percentile(reading, 50)),
    reading_start_p95_ms: round(percentile(reading, 95)),
    speech_chars: events.filter((e) => e.port === 'speech').reduce((s, e) => s + (e.units?.chars ?? 0), 0),
    // only when every turn's model is in the price table; a partial sum would read as cheap
    conversation_usd: costs.length && costs.every((c) => c !== undefined) ? round(costs.reduce((s, c) => s! + c!, 0), 4) : undefined,
    errors,
  }
  return { row, misses }
}
