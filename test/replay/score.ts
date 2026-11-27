// Scoring for a replay run: did the agent pick the right tool with the right
// arguments, and the run's numbers folded into one CSV row. Pure, so it is
// tested on its own (score.test.ts) and a run only adds the calls.
import type { Block } from '../../api/_lib/ports.ts'

/**
 * What one argument must be. A number or boolean must be equal, a string must be
 * contained (any case), and the object forms cover the rest: a pattern, a range,
 * or just being there.
 */
export type Matcher = number | boolean | string | { re: string } | { gt?: number; lt?: number } | { any: true }

/**
 * One acceptable answer to a command. Several in a list mean any one will do,
 * since "jump to the storm" is right as a search or as a read from paragraph 7.
 *   tool    that tool was called, with these arguments
 *   words   the agent answered in words, calling nothing but read_aloud
 *   stop    the agent called nothing, so playback stays stopped
 */
export type Expectation = { tool: string; args?: Record<string, Matcher> } | { words: true } | { stop: true }

export interface Command {
  say: string
  expect: Expectation[]
}

export interface Verdict {
  /** The right kind of answer: the tool, or words, or silence. */
  tool: boolean
  /** That, and its arguments match too. */
  args: boolean
}

function matches(m: Matcher, v: unknown): boolean {
  if (typeof m === 'number' || typeof m === 'boolean') return v === m
  if (typeof m === 'string') return typeof v === 'string' && v.toLowerCase().includes(m.toLowerCase())
  if ('any' in m) return v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0)
  if ('re' in m) return typeof v === 'string' && new RegExp(m.re, 'i').test(v)
  return typeof v === 'number' && (m.gt === undefined || v > m.gt) && (m.lt === undefined || v < m.lt)
}

type ToolUse = Extract<Block, { type: 'tool_use' }>
const toolUses = (content: Block[]) => content.filter((b): b is ToolUse => b.type === 'tool_use')

/** The best of the command's expectations against what the agent sent back. */
export function score(command: Command, content: Block[]): Verdict {
  const uses = toolUses(content)
  const spoke = content.some((b) => b.type === 'text' && typeof b.text === 'string' && b.text.trim() !== '')
  let best: Verdict = { tool: false, args: false }
  for (const e of command.expect) {
    let v: Verdict
    if ('words' in e) {
      const ok = spoke && uses.every((u) => u.name === 'read_aloud')
      v = { tool: ok, args: ok }
    } else if ('stop' in e) {
      v = { tool: uses.length === 0, args: uses.length === 0 }
    } else {
      const named = uses.filter((u) => u.name === e.tool)
      const args = named.some((u) => Object.entries(e.args ?? {}).every(([k, m]) => matches(m, u.input[k])))
      v = { tool: named.length > 0, args }
    }
    if (v.args) return v
    if (v.tool) best = v
  }
  return best
}

/** Nearest-rank percentile, or undefined for no samples. */
export function percentile(xs: number[], p: number): number | undefined {
  if (xs.length === 0) return undefined
  const sorted = [...xs].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]
}

export interface Row {
  when: string
  label: string
  conversation: string
  model: string
  speech: string
  commands: number
  tool_accuracy: number
  args_accuracy: number
  reply_text_p50_ms?: number
  reply_text_p95_ms?: number
  turn_p50_ms?: number
  reading_start_p50_ms?: number
  /** The slowest of a handful, usually the cold first connection; too few samples for a p95. */
  reading_start_max_ms?: number
  speech_chars: number
  conversation_usd?: number
  errors: number
}

export const COLUMNS: (keyof Row)[] = [
  'when', 'label', 'conversation', 'model', 'speech', 'commands', 'tool_accuracy', 'args_accuracy',
  'reply_text_p50_ms', 'reply_text_p95_ms', 'turn_p50_ms', 'reading_start_p50_ms', 'reading_start_max_ms',
  'speech_chars', 'conversation_usd', 'errors',
]

const cell = (v: unknown) => {
  const s = v === undefined ? '' : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export const csvHeader = () => COLUMNS.join(',')
export const csvRow = (r: Row) => COLUMNS.map((c) => cell(r[c])).join(',')
