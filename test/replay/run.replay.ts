// `npm run replay`: one run against whatever vendors env picks, one CSV row added
// to test/replay/out/results.csv, and every miss printed. Runs on Vitest only so
// the app's own imports resolve without another tool; it is not part of the suite.
//
//   REPLAY_LIVE=1     required when any port is a real vendor: a run spends money
//   REPLAY_LABEL      a name for the row, like "sonnet-5 + elevenlabs"
//   REPLAY_LIMIT      only the first N commands
//   REPLAY_READING    paragraphs for reading start (default 5, 0 skips speech)
//   REPLAY_OUT        another CSV file (default out/results.csv, out/dry-run.csv when any port is fake)
//
// Keys and provider choices come from .env.local and the environment, as for `npm run dev`.
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { it } from 'vitest'
import { providers } from '../../api/_lib/providers.ts'
import commands from './commands.json' with { type: 'json' }
import { runReplay } from './run.ts'
import { csvHeader, csvRow, type Command } from './score.ts'

/** A whole number from env, or the default; anything else stops the run before it spends. */
function count(name: string, fallback: number | undefined): number | undefined {
  const raw = process.env[name]?.trim()
  if (!raw) return fallback
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a whole number, not "${raw}"`)
  return Number(raw)
}

it('replay', async () => {
  const limit = count('REPLAY_LIMIT', undefined)
  const reading = count('REPLAY_READING', undefined)
  const p = providers()
  const used = [p.conversation.name, ...(reading === 0 ? [] : [p.speech.name])]
  if (used.some((n) => n !== 'fake') && process.env.REPLAY_LIVE !== '1') {
    throw new Error(
      `This run would call ${used.filter((n) => n !== 'fake').join(' and ')}, which costs money. ` +
        'Set REPLAY_LIVE=1 to go ahead, or AGENT_PROVIDER=fake TTS_PROVIDER=fake for a free dry run.',
    )
  }
  const { row, misses } = await runReplay({
    commands: (commands as Command[]).slice(0, limit),
    label: process.env.REPLAY_LABEL,
    readingParagraphs: reading,
  })

  // a run with any fake in it would sit among the real rows and skew a comparison
  const real = used.every((n) => n !== 'fake')
  const out = process.env.REPLAY_OUT ?? `test/replay/out/${real ? 'results' : 'dry-run'}.csv`
  mkdirSync(dirname(out), { recursive: true })
  if (!existsSync(out)) appendFileSync(out, `${csvHeader()}\n`)
  appendFileSync(out, `${csvRow(row)}\n`)

  for (const m of misses) {
    const what = m.error ? `error: ${m.error}` : `${m.verdict.tool ? 'wrong arguments' : 'wrong tool'}: ${m.got}`
    process.stdout.write(`miss  "${m.say}"  ${what}\n`)
  }
  process.stdout.write(`\n${csvHeader()}\n${csvRow(row)}\n\nadded to ${out}\n`)
})
