// `npm run replay`: one run against whatever vendors env picks, one CSV row added
// to test/replay/out/results.csv, and every miss printed. Runs on Vitest only so
// the app's own imports resolve without another tool; it is not part of the suite.
//
//   REPLAY_LIVE=1     required when any port is a real vendor: a run spends money
//   REPLAY_LABEL      a name for the row, like "sonnet-5 + elevenlabs"
//   REPLAY_LIMIT      only the first N commands
//   REPLAY_READING    paragraphs for reading start (default 5, 0 skips speech)
//   REPLAY_OUT        another CSV file (default out/results.csv, out/dry-run.csv on fakes)
//
// Keys and provider choices come from .env.local and the environment, as for `npm run dev`.
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { it } from 'vitest'
import { providers } from '../../api/_lib/providers.ts'
import commands from './commands.json' with { type: 'json' }
import { runReplay } from './run.ts'
import { csvHeader, csvRow, type Command } from './score.ts'

it('replay', async () => {
  const p = providers()
  const used = [p.conversation.name, ...(process.env.REPLAY_READING === '0' ? [] : [p.speech.name])]
  const live = used.some((n) => n !== 'fake')
  if (live && process.env.REPLAY_LIVE !== '1') {
    throw new Error(
      `This run would call ${used.filter((n) => n !== 'fake').join(' and ')}, which costs money. ` +
        'Set REPLAY_LIVE=1 to go ahead, or AGENT_PROVIDER=fake TTS_PROVIDER=fake for a free dry run.',
    )
  }
  const limit = process.env.REPLAY_LIMIT ? Number(process.env.REPLAY_LIMIT) : undefined
  const reading = process.env.REPLAY_READING === undefined ? undefined : Number(process.env.REPLAY_READING)
  const { row, misses } = await runReplay({
    commands: (commands as Command[]).slice(0, limit),
    label: process.env.REPLAY_LABEL,
    readingParagraphs: reading,
  })

  // a dry run's row would sit among the real ones and drag a comparison down
  const out = process.env.REPLAY_OUT ?? `test/replay/out/${live ? 'results' : 'dry-run'}.csv`
  mkdirSync(dirname(out), { recursive: true })
  if (!existsSync(out)) appendFileSync(out, `${csvHeader()}\n`)
  appendFileSync(out, `${csvRow(row)}\n`)

  for (const m of misses) {
    const what = m.error ? `error: ${m.error}` : `${m.verdict.tool ? 'wrong arguments' : 'wrong tool'}: ${m.got}`
    process.stdout.write(`miss  "${m.say}"  ${what}\n`)
  }
  process.stdout.write(`\n${csvHeader()}\n${csvRow(row)}\n\nadded to ${out}\n`)
})
