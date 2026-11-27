// The tool-call layer end to end: the shared conversation loop (shared/voice/
// agent.ts) driving the real server turn (agentTurn), with the conversation
// model mocked at its port. What it pins down: a spoken "is that true?" starts
// a background check and keeps the book reading in the same turn, instead of
// waiting 5 to 30 seconds for a verdict.
import assert from 'node:assert/strict'
import { afterEach, describe, it, vi } from 'vitest'
import { override } from './_lib/providers.ts'
import type { Block as ServerBlock, ConversationModel } from './_lib/ports.ts'
import { agentTurn, type AgentContext } from './_impl.ts'
import { createAgent, type Block } from '../shared/voice/agent.ts'

const paragraphs = [
  'The Great Wall of China is visible from the Moon with the naked eye.',
  'It was built over many centuries.',
]
const context = (): AgentContext => ({
  title: 'Walls',
  totalParagraphs: paragraphs.length,
  currentParagraph: 0,
  chapters: [],
  rate: 1,
  nearbyText: paragraphs.map((p, i) => `[${i}] ${p}`).join('\n\n'),
})

/** A model that answers every turn with the same blocks. */
function model(content: ServerBlock[]): ConversationModel & { turn: ReturnType<typeof vi.fn> } {
  return {
    name: 'mock',
    turn: vi.fn(async () => ({ content, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
  }
}

afterEach(() => override('conversation', null))

describe('agent loop over the real server turn', () => {
  it('a fact check starts in the background and reading resumes in the same turn', async () => {
    const m = model([
      { type: 'text', text: "I'll check that." },
      { type: 'tool_use', id: 't1', name: 'fact_check', input: { claim: paragraphs[0], anchor: 0 } },
      { type: 'tool_use', id: 't2', name: 'read_aloud', input: { from: 0 } },
    ])
    override('conversation', m)

    const ranges: number[] = []
    let finishRange: ((o: 'completed' | 'stopped') => void) | null = null
    let state = 'idle'
    const factCheck = vi.fn((_input: Record<string, unknown>) => 'Started a background fact check.')

    const agent = createAgent({
      player: {
        setParagraphs() {},
        setRate() {},
        playFrom(from: number) {
          ranges.push(from)
          return new Promise((r) => { finishRange = r })
        },
        pause() { finishRange?.('stopped') },
        hold() {},
        release() {},
        held: false,
        speak: async () => {},
        currentIndex: 0,
        recentlySpoken: '',
      },
      state: {
        agentState: () => state as never,
        setAgentState: (s) => { state = s },
        playing: () => finishRange !== null,
        paragraphs: () => paragraphs.map((text) => ({ text, chapterIndex: 0 })),
        currentParagraph: () => 0,
        rate: () => 1,
        setRate() {},
        chapters: () => [],
        setInterim() {},
        pushChat() {},
        updateChat() {},
        setNotice: (msg) => { throw new Error(`unexpected notice: ${msg}`) },
      },
      decide: async () => null,
      api: async (messages, ctx) => ({ content: (await agentTurn(messages as never, ctx as AgentContext)).content as Block[] }),
      runNav: async () => ({ chat: '', note: '' }),
      tools: { fact_check: factCheck },
      buildContext: context,
      newId: (() => { let n = 0; return () => `id${++n}` })(),
      now: () => Date.now(),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    })

    agent.say('wait, is that true?')
    await vi.waitFor(() => assert.deepEqual(ranges, [0]))
    assert.equal(m.turn.mock.calls.length, 1, 'one model turn: no second turn to wait for the verdict')
    assert.equal(factCheck.mock.calls.length, 1)
    assert.deepEqual(factCheck.mock.calls[0][0], { claim: paragraphs[0], anchor: 0 })
    assert.equal(state, 'reading')
    finishRange!('completed')
  })
})
