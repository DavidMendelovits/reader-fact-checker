// The replay harness's scoring (score.ts) and one run on mocked ports (run.ts).
import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'vitest'
import type { Block, ConversationModel } from '../../api/_lib/ports.ts'
import { override } from '../../api/_lib/providers.ts'
import { fakeSpeech } from '../../api/_lib/adapters/fake.ts'
import { AGENT_TOOLS } from '../../api/_lib/agent.ts'
import { clientKit } from '../../shared/agent/clients.ts'
import commands from './commands.json' with { type: 'json' }
import { CONTEXT, PARAGRAPHS } from './book.ts'
import { runReplay } from './run.ts'
import { COLUMNS, csvHeader, csvRow, percentile, score, type Command } from './score.ts'

const use = (name: string, input: Record<string, unknown> = {}): Block => ({ type: 'tool_use', id: name, name, input })
const said = (text: string): Block => ({ type: 'text', text })

describe('score', () => {
  it('wants the tool and then its arguments', () => {
    const c: Command = { say: 'go to chapter two', expect: [{ tool: 'read_aloud', args: { from: 5 } }] }
    assert.deepEqual(score(c, [use('read_aloud', { from: 5 })]), { tool: true, args: true })
    assert.deepEqual(score(c, [use('read_aloud', { from: 4 })]), { tool: true, args: false })
    assert.deepEqual(score(c, [use('find_in_document', { query: 'two' })]), { tool: false, args: false })
  })

  it('takes any one of the alternatives, preferring one that matches whole', () => {
    const c: Command = {
      say: 'jump to the storm',
      expect: [{ tool: 'read_aloud', args: { from: 7 } }, { tool: 'find_in_document', args: { query: { re: 'storm' } } }],
    }
    assert.deepEqual(score(c, [said('Sure.'), use('read_aloud', { from: 2 }), use('find_in_document', { query: 'the Storm' })]), { tool: true, args: true })
    assert.deepEqual(score(c, [use('read_aloud', { from: 2 })]), { tool: true, args: false })
  })

  it('reads each kind of matcher', () => {
    const c = (args: Record<string, unknown>): Command => ({ say: '', expect: [{ tool: 't', args: args as never }] })
    const ok = (args: Record<string, unknown>, input: Record<string, unknown>) => score(c(args), [use('t', input)]).args
    assert.ok(ok({ query: 'Sleep' }, { query: 'notes on sleep' }))
    assert.ok(!ok({ rate: 1 }, { rate: '1' }))
    assert.ok(ok({ rate: { gt: 1 } }, { rate: 1.25 }) && !ok({ rate: { gt: 1 } }, { rate: 1 }))
    assert.ok(ok({ rate: { lt: 1 } }, { rate: 0.8 }) && !ok({ rate: { lt: 1 } }, { rate: 'slow' }))
    assert.ok(ok({ claim: { re: 'twenty|20' } }, { claim: 'beams reach 20 miles' }))
    assert.ok(ok({ parts: { any: true } }, { parts: ['a', 'b'] }) && !ok({ parts: { any: true } }, { parts: [] }) && !ok({ parts: { any: true } }, {}))
  })

  it('scores an answer in words and a stop', () => {
    const words: Command = { say: 'where am I', expect: [{ words: true }] }
    assert.ok(score(words, [said('Paragraph 4.'), use('read_aloud')]).args)
    assert.ok(!score(words, [said('Checking.'), use('fact_check', { claim: 'x' })]).args)
    assert.ok(!score(words, [said('  ')]).args)
    const answer: Command = { say: 'what does paraffin mean', expect: [{ words: true, mentions: { re: 'fuel|oil' } }] }
    assert.deepEqual(score(answer, [said('It is a lamp oil.'), use('read_aloud')]), { tool: true, args: true })
    assert.deepEqual(score(answer, [said('You said: what does paraffin mean.')]), { tool: true, args: false }, 'an echo is not an answer')
    const stop: Command = { say: 'stop', expect: [{ stop: true }] }
    assert.ok(score(stop, []).args && score(stop, [said('Okay.')]).args)
    assert.ok(!score(stop, [use('read_aloud')]).tool)
  })

  it('has a corpus of 50 commands naming real tools and paragraphs that exist in the book', () => {
    // a typo here would read as the model's mistake on every run
    const tools = new Set([...AGENT_TOOLS, ...clientKit('web')!.tools].map((t) => t.name))
    assert.equal(commands.length, 50)
    assert.equal(new Set(commands.map((c) => c.say)).size, 50, 'no command twice')
    for (const c of commands as Command[]) {
      assert.ok(c.expect.length > 0, c.say)
      for (const e of c.expect) {
        if (!('tool' in e)) continue
        assert.ok(tools.has(e.tool), `${c.say}: no tool ${e.tool}`)
        for (const k of ['from', 'to'] as const) {
          const v = e.args?.[k]
          if (typeof v === 'number') assert.ok(v >= 0 && v < PARAGRAPHS.length, `${c.say}: ${k} ${v}`)
        }
      }
    }
    assert.match(CONTEXT.nearbyText, /^\[4\] She learned the routine/m)
  })
})

describe('percentile and the CSV', () => {
  it('takes the nearest rank', () => {
    assert.equal(percentile([], 50), undefined)
    assert.equal(percentile([30, 10, 20], 50), 20)
    assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10)
    assert.equal(percentile([5], 95), 5)
  })

  it('writes one column per field, quoting what needs it and leaving gaps blank', () => {
    const row = Object.fromEntries(COLUMNS.map((c) => [c, undefined])) as never
    const line = csvRow({ ...(row as object), label: 'sonnet, "fast"', commands: 3 } as never)
    assert.equal(line.split(',').length, COLUMNS.length + 1, 'the quoted comma stays inside its cell')
    assert.ok(line.includes('"sonnet, ""fast"""'))
    assert.equal(csvHeader().split(',').length, COLUMNS.length)
  })
})

describe('a run', () => {
  afterEach(() => {
    override('conversation', null)
    override('speech', null)
  })

  it('scores every command, times the turns and the first audio, and adds up the cost', async () => {
    const answers: Record<string, Block[]> = {
      'go to chapter two': [said('Chapter two.'), use('read_aloud', { from: 5 })],
      faster: [use('set_speed', { rate: 0.5 })],
      stop: [],
    }
    const conversation: ConversationModel = {
      name: 'scripted',
      async turn(req, hooks = {}) {
        const say = req.messages[0].content as string
        if (say === 'explode') throw new Error('vendor down')
        const content = answers[say]
        if (content[0]?.type === 'text') hooks.onText?.(content[0].text as string)
        return { content, model: 'claude-sonnet-5', usage: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 } }
      },
    }
    override('conversation', conversation)
    override('speech', fakeSpeech())
    const corpus = (commands as Command[]).filter((c) => c.say in answers)
    const { row, misses } = await runReplay({
      commands: [...corpus, { say: 'explode', expect: [{ stop: true }] }],
      label: 'mocked',
      readingParagraphs: 2,
      now: () => new Date('2026-11-27T00:00:00Z'),
    })
    assert.equal(row.when, '2026-11-27T00:00:00.000Z')
    assert.equal(row.conversation, 'scripted')
    assert.equal(row.model, 'claude-sonnet-5')
    assert.equal(row.speech, 'fake')
    assert.equal(row.commands, 4)
    assert.equal(row.tool_accuracy, 0.75, 'chapter two, faster and stop picked the right tool')
    assert.equal(row.args_accuracy, 0.5, 'faster had the wrong rate')
    assert.equal(row.errors, 1)
    assert.equal(row.speech_chars, PARAGRAPHS[0].length + PARAGRAPHS[1].length)
    assert.equal(row.conversation_usd, 6, 'three turns at a million input tokens, $2 each')
    assert.ok(row.reply_text_p50_ms !== undefined && row.reading_start_p50_ms !== undefined)
    assert.deepEqual(misses.map((m) => m.say), ['faster', 'explode'])
    assert.match(misses[0].got, /set_speed\(\{"rate":0.5\}\)/)
    assert.equal(misses[1].error, 'vendor down')
  })

  it('says why the voice failed instead of only counting it', async () => {
    override('conversation', { name: 'scripted', turn: async () => ({ content: [] }) })
    override('speech', { name: 'broken', mimeType: 'audio/mpeg', maxChars: null, synthesize: async () => Promise.reject(new Error('bad key')) })
    const { row, misses } = await runReplay({ commands: [], readingParagraphs: 1 })
    assert.equal(row.errors, 1)
    assert.equal(row.reading_start_p50_ms, undefined)
    assert.deepEqual(misses, [{ say: '(reading paragraph 0)', verdict: { tool: false, args: false }, got: '', error: 'bad key' }])
  })
})
