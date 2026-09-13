// Port of the web agent loop (src/lib/agent.ts) plus the controller wiring.
// The architecture survives the platform change intact: the agent drives playback
// through read_aloud, which holds until the range ends or the user talks over it;
// transport commands run locally off partial transcripts; fact-check verdicts are
// spoken as soon as they exist. The model itself stays behind the deployed web
// app's /api routes — no keys in this bundle.
import { useStore } from './store'
import { tts, voice } from './providers'
import { apiJson, apiBase } from './settings'
import type { Highlight } from './types'

type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string }
type Msg = { role: 'user' | 'assistant'; content: string | Block[] }

const MAX_TURNS = 12

let messages: Msg[] = []
let running = false
let pending: string | null = null
let awaitingWords = false

let counter = 0
const newId = () => `m-${Date.now()}-${++counter}`

useStore.subscribe((s, prev) => {
  if (s.doc !== prev.doc) {
    messages = []
    pending = null
  }
})

/** Patch a synthetic result under every orphaned tool_use before sending. */
function repair(msgs: Msg[]): Msg[] {
  const out: Msg[] = []
  for (const m of msgs) {
    const prev = out[out.length - 1]
    if (prev?.role === 'assistant' && Array.isArray(prev.content)) {
      const unanswered = prev.content
        .filter((b): b is Extract<Block, { type: 'tool_use' }> => b.type === 'tool_use')
        .filter(
          (call) =>
            !(m.role === 'user' && Array.isArray(m.content) &&
              m.content.some((b) => b.type === 'tool_result' && b.tool_use_id === call.id)),
        )
      if (unanswered.length > 0) {
        const results: Block[] = unanswered.map((call) => ({
          type: 'tool_result', tool_use_id: call.id,
          content: '[Interrupted — the app was closed before this finished.]',
        }))
        if (m.role === 'user') {
          m.content = [...results, ...(typeof m.content === 'string' ? [{ type: 'text', text: m.content } as Block] : m.content)]
        } else {
          out.push({ role: 'user', content: results })
        }
      }
    }
    out.push(m)
  }
  const tail = out[out.length - 1]
  if (tail?.role === 'assistant' && Array.isArray(tail.content)) {
    const calls = tail.content.filter((b): b is Extract<Block, { type: 'tool_use' }> => b.type === 'tool_use')
    if (calls.length > 0) {
      out.push({
        role: 'user',
        content: calls.map((call) => ({
          type: 'tool_result', tool_use_id: call.id,
          content: '[Interrupted — the app was closed before this finished.]',
        })),
      })
    }
  }
  return out
}

function buildContext() {
  const s = useStore.getState()
  const cur = Math.min(s.currentParagraph, Math.max(0, s.paragraphs.length - 1))
  const from = Math.max(0, cur - 2)
  const to = Math.min(s.paragraphs.length - 1, cur + 1)
  let n = 0
  const chapters = (s.doc?.chapters ?? []).map((ch) => {
    const startsAt = n
    n += ch.paragraphs.length
    return { title: ch.title, startsAt }
  })
  return {
    title: s.doc?.title ?? 'Untitled',
    totalParagraphs: s.paragraphs.length,
    currentParagraph: cur,
    chapters,
    rate: s.rate,
    nearbyText: s.paragraphs
      .slice(from, to + 1)
      .map((p, i) => `[${from + i}] ${p.text}`)
      .join('\n\n'),
  }
}

// ---- client-side tools ----

async function playRange(from: number, to: number): Promise<'completed' | 'stopped'> {
  const s = useStore.getState()
  tts.setParagraphs(s.paragraphs.map((p) => p.text))
  tts.setRate(s.rate)
  useStore.setState({ agentState: 'reading' })
  const outcome = await tts.playFrom(from, to)
  useStore.setState({ agentState: running ? 'thinking' : 'idle' })
  return outcome
}

async function readAloud(input: Record<string, unknown>): Promise<string> {
  const s = useStore.getState()
  if (s.paragraphs.length === 0) return 'No document is loaded.'
  const last = s.paragraphs.length - 1
  const clamp = (n: number) => Math.max(0, Math.min(last, n))
  const from = Number.isInteger(input.from) ? clamp(input.from as number) : clamp(s.currentParagraph)
  const to = Number.isInteger(input.to) ? clamp(input.to as number) : last
  const outcome = await playRange(from, to)
  const stoppedAt = tts.currentIndex
  return outcome === 'completed'
    ? `Read paragraphs ${from} through ${to}. Position is now paragraph ${Math.min(to + 1, last)}.`
    : `The user interrupted at paragraph ${stoppedAt}, which reads: "${s.paragraphs[stoppedAt]?.text ?? ''}"`
}

interface FactCheckResult {
  verdict: string
  summary: string
  spokenSummary: string
  sources: { title: string; url: string }[]
}

/**
 * /api/factcheck speaks NDJSON. React Native's fetch has no streaming body, so the
 * per-field early speak the web does is off the table — await the whole thing and
 * speak the verdict once. Still one round-trip.
 */
async function factCheck(input: Record<string, unknown>): Promise<string> {
  const claim = String(input.claim ?? '')
  const res = await fetch(`${apiBase}/api/factcheck`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ passage: claim }),
  })
  if (!res.ok) return `The fact check failed (${res.status}).`
  const lines = (await res.text()).split('\n').filter(Boolean)
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as { type: string; result?: FactCheckResult; error?: string }
      if (parsed.type === 'done' && parsed.result) {
        const r = parsed.result
        useStore.getState().pushChat({ id: newId(), role: 'assistant', text: `${r.verdict}: ${r.summary}` })
        useStore.setState({ agentState: 'speaking' })
        await tts.speak(r.spokenSummary)
        return `[Already read aloud to the user, verbatim: "${r.spokenSummary}". Add nothing unless the user asked something this does not answer.]`
      }
      if (parsed.type === 'error') return `The fact check failed: ${parsed.error}`
    } catch { /* delta lines and partial JSON — skip */ }
  }
  return 'The fact check returned nothing usable.'
}

function findInDocument(input: Record<string, unknown>): string {
  const terms = String(input.query ?? '').toLowerCase().match(/[a-z0-9']+/g)
  if (!terms?.length) return 'No query given.'
  const hits = useStore
    .getState()
    .paragraphs.map((p, i) => {
      const text = p.text.toLowerCase()
      return { i, text: p.text, score: terms.filter((t) => text.includes(t)).length }
    })
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, 6)
  if (hits.length === 0) return `Nothing in the document matches "${input.query}".`
  return hits.map((h) => `[${h.i}] ${h.text.slice(0, 180)}`).join('\n')
}

function highlight(input: Record<string, unknown>): string {
  const s = useStore.getState()
  const text = String(input.text ?? '').trim()
  if (!text) return 'No passage was given to highlight.'
  const last = Math.max(0, s.paragraphs.length - 1)
  const anchor = Number.isInteger(input.anchor)
    ? Math.max(0, Math.min(last, input.anchor as number))
    : Math.min(last, s.currentParagraph)
  const h: Highlight = {
    id: newId(), anchor, text,
    note: typeof input.note === 'string' && input.note.trim() ? input.note.trim() : undefined,
    createdAt: Date.now(),
  }
  s.addHighlight(h)
  return `Saved that passage to the highlights, anchored at paragraph ${anchor}.`
}

function setSpeed(input: Record<string, unknown>): string {
  const rate = Math.max(0.5, Math.min(3, Number(input.rate) || 1))
  useStore.getState().setRate(rate)
  tts.setRate(rate)
  return `Playback speed is now ${rate}x.`
}

async function runTool(block: Extract<Block, { type: 'tool_use' }>): Promise<Block> {
  let content: string
  switch (block.name) {
    case 'read_aloud': content = await readAloud(block.input); break
    case 'fact_check': content = await factCheck(block.input); break
    case 'find_in_document': content = findInDocument(block.input); break
    case 'set_speed': content = setSpeed(block.input); break
    case 'highlight': content = highlight(block.input); break
    default: content = `Unknown tool: ${block.name}`
  }
  return { type: 'tool_result', tool_use_id: block.id, content }
}

// ---- fast-path commands (verbatim from the web) ----

const PAUSE = /^(pause|stop|stop reading|quiet|be quiet|shush|hold on|hold up|hang on|wait|wait up|wait a (?:sec|second|minute)|one sec|one second|just a sec|give me a sec)$/
const RESUME = /^(resume|resume reading|unpause|continue|continue reading|keep going|keep reading|go on|carry on|go ahead|play|read|start|start reading|read it|keep on going)$/
const FASTER = /^(faster|go faster|speed up|speed it up|a (?:bit|little) faster)$/
const SLOWER = /^(slower|go slower|slow down|slow it down|a (?:bit|little) slower)$/
const NUMERIC_RATE = /^(?:go |set (?:the )?speed to )?(\d(?:\.\d+)?)\s*(?:x|times)(?: speed)?$/
const NAMED_RATES: Record<string, number> = {
  'normal speed': 1, 'regular speed': 1, normal: 1, 'back to normal': 1,
  'one x': 1, 'one and a half x': 1.5, 'two x': 2, 'three x': 3,
  'half speed': 0.5, 'double speed': 2,
}

const normalize = (text: string) => text.toLowerCase().replace(/[.!,?]+$/, '').trim()

type FastResult = { chat: string; note: string }

function matchFast(text: string): (() => FastResult) | null {
  const t = normalize(text)
  if (t.split(/\s+/).length > 6) return null

  if (PAUSE.test(t)) {
    return () => {
      tts.pause()
      return { chat: 'Paused.', note: 'Paused playback.' }
    }
  }

  if (RESUME.test(t) && !running) {
    const s = useStore.getState()
    if (s.paragraphs.length === 0) return null
    const from = Math.min(s.currentParagraph, s.paragraphs.length - 1)
    return () => {
      void playRange(from, useStore.getState().paragraphs.length - 1)
      return { chat: 'Reading.', note: `Resumed reading from paragraph ${from}.` }
    }
  }

  const named = NAMED_RATES[t]
  const numeric = t.match(NUMERIC_RATE)
  let rate: number | null = null
  if (FASTER.test(t)) rate = useStore.getState().rate + 0.25
  else if (SLOWER.test(t)) rate = useStore.getState().rate - 0.25
  else if (typeof named === 'number') rate = named
  else if (numeric) rate = Number(numeric[1])
  if (rate != null) {
    const r = rate
    return () => {
      const note = setSpeed({ rate: r })
      return { chat: `${useStore.getState().rate}x.`, note }
    }
  }

  return null
}

const fastCommand = (text: string): FastResult | null => matchFast(text)?.() ?? null

// ---- turn loop ----

let listenTimer: ReturnType<typeof setTimeout> | null = null
const restState = () => (running ? ('thinking' as const) : ('idle' as const))

export function beginUtterance() {
  awaitingWords = true
  tts.pause()
  useStore.setState({ agentState: 'listening' })
  if (listenTimer) clearTimeout(listenTimer)
  listenTimer = setTimeout(() => {
    awaitingWords = false
    if (useStore.getState().agentState === 'listening') useStore.setState({ agentState: restState() })
  }, 5000)
}

let handledEarly: { text: string; at: number; chatId: string | null } | null = null
const EARLY_DEDUP_WINDOW = 6000

export function sayInterim(text: string) {
  const t = normalize(text)
  if (!t || !matchFast(t)) return
  if (handledEarly && Date.now() - handledEarly.at < EARLY_DEDUP_WINDOW) return
  handledEarly = { text: t, at: Date.now(), chatId: null }
  handledEarly.chatId = say(text)
}

export function say(text: string): string | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  const early = handledEarly
  handledEarly = null
  if (early && Date.now() - early.at < EARLY_DEDUP_WINDOW) {
    const n = normalize(trimmed)
    if ((n === early.text || n.startsWith(`${early.text} `)) && matchFast(n)) {
      if (early.chatId) useStore.getState().updateChat(early.chatId, { text: trimmed })
      return early.chatId
    }
  }
  awaitingWords = false
  const chatId = newId()
  useStore.getState().pushChat({ id: chatId, role: 'user', text: trimmed })
  if (useStore.getState().agentState === 'listening') useStore.setState({ agentState: restState() })

  const fast = fastCommand(trimmed)
  if (fast) {
    useStore.getState().pushChat({ id: newId(), role: 'assistant', text: fast.chat })
    if (running) {
      const done = `${trimmed} [the app already did this: ${fast.note}]`
      pending = pending ? `${pending} ${done}` : done
    } else {
      messages.push({ role: 'user', content: trimmed })
      messages.push({ role: 'assistant', content: fast.note })
    }
    return chatId
  }

  if (running) {
    pending = pending ? `${pending} ${trimmed}` : trimmed
    tts.pause()
    return chatId
  }
  messages.push({ role: 'user', content: trimmed })
  void loop()
  return chatId
}

export function openingTurn() {
  if (running || messages.length > 0) return
  messages.push({ role: 'user', content: '[The reader just opened this document and is listening. Take it from here.]' })
  void loop()
}

async function settle(ms = 3000) {
  const deadline = Date.now() + ms
  while (awaitingWords && !pending && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100))
  }
  awaitingWords = false
  if (useStore.getState().agentState === 'listening') useStore.setState({ agentState: 'thinking' })
}

async function loop() {
  running = true
  messages = repair(messages)
  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      useStore.setState({ agentState: 'thinking' })
      const { content } = await apiJson<{ content: Block[] }>('/api/agent', {
        messages,
        context: buildContext(),
      })
      messages.push({ role: 'assistant', content })

      const spoken = content
        .filter((b): b is Extract<Block, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join(' ')
        .trim()
      if (spoken) {
        useStore.getState().pushChat({ id: newId(), role: 'assistant', text: spoken })
        useStore.setState({ agentState: 'speaking' })
        await tts.speak(spoken)
      }

      const calls = content.filter(
        (b): b is Extract<Block, { type: 'tool_use' }> => b.type === 'tool_use',
      )
      if (calls.length === 0) break

      const results: Block[] = []
      for (const call of calls) {
        results.push(
          pending
            ? { type: 'tool_result', tool_use_id: call.id, content: '[Not run — the user said something first. Deal with that instead.]' }
            : await runTool(call),
        )
      }
      if (awaitingWords) await settle()
      if (pending) {
        results.push({ type: 'text', text: pending })
        pending = null
      }
      messages.push({ role: 'user', content: results })
    }
  } catch (e) {
    tts.pause()
    useStore.setState({ notice: e instanceof Error ? e.message : String(e) })
  } finally {
    running = false
    useStore.setState({ agentState: 'idle' })
  }

  if (pending) {
    messages.push({ role: 'user', content: pending })
    pending = null
    void loop()
  }
}

// ---- controller wiring (the web keeps this in controller.ts; here it's four lines) ----

voice.onUtterance = (text) => say(text)
voice.onInterim = (text) => sayInterim(text)
voice.onSpeechStart = () => beginUtterance()
voice.getRecentSpokenText = () => tts.recentlySpoken
voice.onError = (msg) => useStore.setState({ micEnabled: false, notice: msg })
tts.onParagraphChange = (i) => useStore.setState({ currentParagraph: i })
tts.onPlayingChange = (playing) => useStore.setState({ playing })

export function setMicEnabled(enabled: boolean) {
  useStore.setState({ micEnabled: enabled })
  if (enabled) void voice.start()
  else voice.stop()
}

export function play() {
  const s = useStore.getState()
  void playRange(Math.min(s.currentParagraph, s.paragraphs.length - 1), s.paragraphs.length - 1)
}

export function pause() {
  tts.pause()
}
