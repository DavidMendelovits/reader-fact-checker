// The conversation is the app. Everything the user says becomes a turn; the agent
// drives playback and fact-checking through tools it calls back into the client.
//
// read_aloud is the load-bearing one: it resolves only when the range finishes or
// the user talks over it, so a chapter of narration costs one model round-trip
// rather than one per paragraph. When it comes back interrupted, the interrupting
// utterance rides along in the same user turn as the tool result — that is what
// lets "wait, what was that?" resolve against the text that was just read.
import { useStore } from '../store'
import { tts, type SpeechStream } from './tts'
import { checkPassage, completeField } from './factcheck'
import { blip } from './earcon'
import { apiNdjson } from './api'
import { SentenceSplitter } from './sentences'
import type { Doc, FactCheckJob, Highlight } from '../types'

type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string }
type Msg = { role: 'user' | 'assistant'; content: string | Block[] }

const MAX_TURNS = 12 // backstop against a tool-call loop

let messages: Msg[] = []
let running = false
let pending: string | null = null
let awaitingWords = false // speech started; transcript not in yet
let reopenedAt: number | null = null // set by persist when a saved entry is reopened

let jobCounter = 0
const newId = () => `job-${Date.now()}-${++jobCounter}`

// a new document is a new conversation
useStore.subscribe((s, prev) => {
  if (s.doc !== prev.doc) {
    messages = []
    pending = null
    // openEntry marks the reopen *after* setDoc, so this only clears a stale mark
    reopenedAt = null
  }
})

// The raw tool-use transcript is what actually carries context — the rendered chat
// log is a lossy view of it — so persistence round-trips this, not the bubbles.
export const exportMessages = (): unknown[] => messages
export function restoreMessages(saved: unknown[]) {
  messages = repair((saved as Msg[]) ?? [])
}

/**
 * A transcript can end up with a tool_use no tool_result ever answered — a reload
 * mid-read_aloud persists exactly that, and a fast-path append lands plain text
 * after it. The API rejects the whole conversation then, so patch in a synthetic
 * result for every orphaned call before sending.
 */
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
          content: '[Interrupted — the app was closed or reloaded before this finished.]',
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
          content: '[Interrupted — the app was closed or reloaded before this finished.]',
        })),
      })
    }
  }
  return out
}

// ---- context sent with every turn (position moves, so it can't be cached) ----

function chapterStarts(doc: Doc) {
  let n = 0
  return doc.chapters.map((ch) => {
    const startsAt = n
    n += ch.paragraphs.length
    return { title: ch.title, startsAt }
  })
}

function buildContext() {
  const s = useStore.getState()
  const cur = Math.min(s.currentParagraph, Math.max(0, s.paragraphs.length - 1))
  const from = Math.max(0, cur - 2)
  const to = Math.min(s.paragraphs.length - 1, cur + 1)
  return {
    title: s.doc?.title ?? 'Untitled',
    totalParagraphs: s.paragraphs.length,
    currentParagraph: cur,
    chapters: s.doc ? chapterStarts(s.doc) : [],
    rate: s.rate,
    nearbyText: s.paragraphs
      .slice(from, to + 1)
      .map((p, i) => `[${from + i}] ${p.text}`)
      .join('\n\n'),
  }
}

// ---- client-side tools ----

/**
 * Play a range and hold until it ends or the user talks over it. Shared by the
 * read_aloud tool and the "keep going" fast path.
 */
async function playRange(from: number, to: number): Promise<'completed' | 'stopped'> {
  const s = useStore.getState()
  tts.setParagraphs(s.paragraphs.map((p) => p.text))
  tts.setRate(s.rate)
  useStore.setState({ agentState: 'reading' }) // `playing` is driven by tts.onPlayingChange
  const outcome = await tts.playFrom(from, to)
  // Playback is over the moment playFrom returns. Leaving the state on 'reading'
  // through the settle window and the next model turn made the UI claim it was
  // still reading for seconds after the audio stopped.
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

async function factCheck(input: Record<string, unknown>): Promise<string> {
  const claim = String(input.claim ?? '')
  const anchor = Number.isInteger(input.anchor) ? (input.anchor as number) : useStore.getState().currentParagraph
  const job: FactCheckJob = {
    id: newId(), kind: 'voice', status: 'running',
    excerpt: claim, anchor, createdAt: Date.now(),
    // "highlight that, is it true?" makes two tool calls; link the check to the
    // highlight already sitting on the same paragraph so the hover card has both.
    highlightId: useStore.getState().highlights.find((h) => h.anchor === anchor)?.id,
  }
  useStore.getState().addJob(job)

  // spokenSummary is written to be read aloud and closes well before the written
  // summary and the sources do. Saying it the moment it lands skips a whole model
  // turn and a second synthesis that only rephrased what we already had.
  let speaking: Promise<void> | null = null
  let said = ''
  const say = (line: string) => {
    if (said || !line) return
    said = line
    useStore.getState().pushChat({ id: newId(), role: 'assistant', text: line })
    useStore.setState({ agentState: 'speaking' })
    speaking = tts.speak(line)
  }

  try {
    const result = await checkPassage(claim, (raw) => {
      useStore.getState().updateJob(job.id, { partial: raw })
      say(completeField(raw, 'spokenSummary'))
    })
    useStore.getState().updateJob(job.id, { status: 'done', result })
    say(result.spokenSummary) // a cached verdict resolves with no stream to speak from
    // Hold the tool open until the verdict has been read out. The next model turn
    // begins the moment this returns, and anything it says calls tts.speak(), which
    // pauses the player first — cutting our own verdict off mid-sentence.
    if (speaking) await speaking
    return said
      ? `[Already read aloud to the user, verbatim: "${said}" — the card with sources is on screen. Add nothing unless the user asked something this does not answer.]`
      : JSON.stringify({ verdict: result.verdict, findings: result.summary })
  } catch (e) {
    useStore.getState().updateJob(job.id, { status: 'error', error: String(e) })
    return `The fact check failed: ${e instanceof Error ? e.message : String(e)}`
  }
}

function findInDocument(input: Record<string, unknown>): string {
  const terms = String(input.query ?? '')
    .toLowerCase()
    .match(/[a-z0-9']+/g)
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
    case 'read_aloud':
      content = await readAloud(block.input)
      break
    case 'fact_check':
      content = await factCheck(block.input)
      break
    case 'find_in_document':
      content = findInDocument(block.input)
      break
    case 'set_speed':
      content = setSpeed(block.input)
      break
    case 'highlight':
      content = highlight(block.input)
      break
    default:
      content = `Unknown tool: ${block.name}`
  }
  return { type: 'tool_result', tool_use_id: block.id, content }
}

// ---- fast-path commands ----
//
// "Pause" has to stop the audio now, not a model round-trip from now. A small regex
// table catches the handful of utterances that can only mean one thing; anything
// with more in it — "wait, is that true?" — still goes to the model.

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

/**
 * Matches without doing anything, so a partial transcript can be tested before we
 * decide to act on it. Returns the action to run, or null to defer to the model.
 */
function matchFast(text: string): (() => FastResult) | null {
  const t = normalize(text)
  if (t.split(/\s+/).length > 6) return null

  if (PAUSE.test(t)) {
    return () => {
      tts.pause() // flips store.playing through tts.onPlayingChange
      return { chat: 'Paused.', note: 'Paused playback.' }
    }
  }

  // Mid-loop, resuming is the model's call — a second playback started underneath a
  // read_aloud that's still awaiting would fight it for the player.
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
      const note = setSpeed({ rate: r }) // clamps and updates the store and the player
      return { chat: `${useStore.getState().rate}x.`, note }
    }
  }

  return null
}

/** Runs the command if the utterance is only that; returns null to defer to the model. */
const fastCommand = (text: string): FastResult | null => matchFast(text)?.() ?? null

// ---- turn loop ----

let listenTimer: ReturnType<typeof setTimeout> | null = null

/** Nothing is happening unless a turn is in flight, in which case we're thinking. */
const restState = () => (running ? 'thinking' : 'idle')

/**
 * The user has started talking. Narration stops immediately — the conversation and
 * the reading never run at the same time — and the loop then waits briefly for the
 * words, so it doesn't answer an interruption before hearing what it was.
 */
export function beginUtterance() {
  awaitingWords = true
  tts.pause()
  useStore.setState({ agentState: 'listening' })
  // A false start, or an utterance the echo filter throws away, never reaches
  // say() — don't leave the panel claiming we're still listening for it.
  if (listenTimer) clearTimeout(listenTimer)
  listenTimer = setTimeout(() => {
    awaitingWords = false
    if (useStore.getState().agentState === 'listening') useStore.setState({ agentState: restState() })
  }, 5000)
}

/**
 * Hand the agent something the user said. While a turn is already in flight this
 * cancels playback instead of queueing — that *is* the interruption path.
 */
/**
 * A transport command heard on a partial transcript, waiting for its final to show
 * up so we can drop it. Time-boxed: a final that never arrives must not swallow the
 * next real "pause" minutes later.
 */
let handledEarly: { text: string; at: number; chatId: string | null } | null = null
const EARLY_DEDUP_WINDOW = 6000

/**
 * Act on a partial transcript when it can only mean one thing. Chrome finalizes an
 * utterance a beat after you stop talking, which is a long time to keep reading at
 * someone who said "stop". Anything less clear-cut waits for the final, where we
 * know what was actually said.
 */
export function sayInterim(text: string) {
  const t = normalize(text)
  if (!t || !matchFast(t)) return
  // One early command per utterance. A partial arrives several times as it grows,
  // and "stop" then "stop reading" are the same instruction twice.
  if (handledEarly && Date.now() - handledEarly.at < EARLY_DEDUP_WINDOW) return
  handledEarly = { text: t, at: Date.now(), chatId: null }
  // A partial is a prefix, so the bubble this posts shows a truncated version of
  // what the user is still saying. say() corrects it in place once the final lands.
  handledEarly.chatId = say(text)
}

/** Returns the id of the user bubble it posted, so a partial's can be corrected. */
export function say(text: string): string | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  // The final for something already run off its partial. Partials grow as prefixes,
  // so "stop" finalizing as "stop reading" is still the same command — drop it. A
  // final that grew into something more than a command ("stop, go back to chapter
  // two") falls through to the model, which is what should handle it; the pause it
  // already ran is in the transcript, so acting again is at worst a no-op.
  const early = handledEarly
  handledEarly = null
  if (early && Date.now() - early.at < EARLY_DEDUP_WINDOW) {
    const n = normalize(trimmed)
    if ((n === early.text || n.startsWith(`${early.text} `)) && matchFast(n)) {
      // Same utterance finalizing. Don't run it twice — but do replace the partial
      // we showed with what was actually said ("stop" → "stop reading").
      if (early.chatId) useStore.getState().updateChat(early.chatId, { text: trimmed })
      return early.chatId
    }
  }
  awaitingWords = false
  const chatId = newId()
  useStore.getState().pushChat({ id: chatId, role: 'user', text: trimmed })
  if (useStore.getState().agentState === 'listening') useStore.setState({ agentState: restState() })

  // Handled here and now; the model finds out from the transcript on its next turn.
  const fast = fastCommand(trimmed)
  if (fast) {
    useStore.getState().pushChat({ id: newId(), role: 'assistant', text: fast.chat })
    if (running) {
      // rides along with the tool result the loop is about to send, so roles alternate
      const done = `${trimmed} [the app already did this: ${fast.note}]`
      pending = pending ? `${pending} ${done}` : done
    } else {
      messages.push({ role: 'user', content: trimmed })
      messages.push({ role: 'assistant', content: fast.note })
    }
    return chatId
  }

  // Going to the model costs a round-trip of silence. Mark the hand-off so the user
  // knows they were heard — but not over the agent's own reply, where the voice
  // stopping mid-word is already the acknowledgment.
  if (useStore.getState().agentState !== 'speaking') blip()

  if (running) {
    pending = pending ? `${pending} ${trimmed}` : trimmed
    tts.pause() // resolves any in-flight read_aloud as 'stopped'
    return chatId
  }
  messages.push({ role: 'user', content: trimmed })
  void loop()
  return chatId
}

/**
 * Reopening a saved book is a different opening than importing a new one: there is a
 * position to resume from, and possibly a long gap to bridge. persist.openEntry
 * records the gap here; the doc-open turn below picks it up.
 */
export function markReopened(updatedAt: number) {
  reopenedAt = updatedAt
}

const STALE_AFTER = 4 * 60 * 60 * 1000

/** "20 minutes", "6 hours", "3 days" — vague on purpose; it's spoken, not displayed. */
function humanGap(ms: number): string {
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`
  const minutes = Math.round(ms / 60000)
  if (minutes < 90) return plural(Math.max(1, minutes), 'minute')
  const hours = Math.round(minutes / 60)
  if (hours < 36) return plural(hours, 'hour')
  return plural(Math.round(hours / 24), 'day')
}

/**
 * Hand the agent the floor when a document opens. It greets and starts reading on
 * its own — the point is that you never have to reach for a button. A reopened book
 * gets a recap instead of a greeting when it's been sitting a while.
 */
export function openingTurn() {
  if (running) return
  const reopened = reopenedAt
  reopenedAt = null // whatever happens here, this open is spent

  let content: string
  if (reopened != null) {
    const gap = Date.now() - reopened
    const at = useStore.getState().currentParagraph
    content =
      gap > STALE_AFTER
        ? `[The reader is back after ${humanGap(gap)} — they last left off at paragraph ${at}. Give a one-breath spoken recap of where the story stands, then continue reading from there.]`
        : '[The reader just reopened this document. Pick up reading from the current position.]'
  } else if (messages.length === 0) {
    content = '[The reader just opened this document and is listening. Take it from here.]'
  } else {
    return // a conversation already in flight and nothing new to say
  }

  messages.push({ role: 'user', content })
  void loop()
}

/** Give a half-spoken utterance time to finalize before we act on the interruption. */
async function settle(ms = 3000) {
  const deadline = Date.now() + ms
  while (awaitingWords && !pending && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100))
  }
  awaitingWords = false
  if (useStore.getState().agentState === 'listening') useStore.setState({ agentState: 'thinking' })
}

type AgentLine =
  | { type: 'text'; text: string }
  | { type: 'text_end' }
  | { type: 'done'; content: Block[] }
  | { type: 'error'; error: string }

/**
 * One model turn, spoken as it streams. The reply goes to the synthesizer a
 * sentence at a time, so the first one is playing while the model is still
 * writing the rest — and the tool call after it, which is the part that used to
 * hold "let me check that" hostage: the whole fact_check argument had to finish
 * generating before a byte of the reply reached the voice.
 *
 * Resolves with the full content once the reply has been *spoken*, not just
 * received. Tools run after that, same as before: read_aloud and the next
 * tts.speak() both take the player, and would cut the reply off mid-word.
 */
async function speakTurn(): Promise<Block[]> {
  const splitter = new SentenceSplitter()
  // assigned from inside the stream callback, which is why it's a holder and not
  // three lets — control-flow narrowing can't see writes from a closure
  const st: { speech?: SpeechStream; chatId?: string; content?: Block[]; sofar: string } = { sofar: '' }

  const speak = (sentence: string) => {
    if (!st.speech) {
      st.speech = tts.speakStream()
      useStore.setState({ agentState: 'speaking' })
    }
    st.speech.push(sentence)
  }
  const onText = (text: string) => {
    st.sofar += text
    // the bubble fills in as the words arrive; it is corrected from the transcript below
    const shown = st.sofar.trim()
    if (shown) {
      if (st.chatId) useStore.getState().updateChat(st.chatId, { text: shown })
      else useStore.getState().pushChat({ id: (st.chatId = newId()), role: 'assistant', text: shown })
    }
    for (const s of splitter.push(text)) speak(s)
  }
  // a text block closed: whatever is left is a whole sentence, whitespace or not
  const onTextEnd = () => {
    const tail = splitter.flush()
    if (tail) speak(tail)
    st.sofar += ' ' // the transcript joins text blocks with a space
  }

  try {
    await apiNdjson<AgentLine>('/api/agent-stream', { messages, context: buildContext() }, (msg) => {
      if (msg.type === 'text') onText(msg.text)
      else if (msg.type === 'text_end') onTextEnd()
      else if (msg.type === 'done') st.content = msg.content
      else throw new Error(msg.error)
    })
    if (!st.content) throw new Error('The agent stream ended without a response.')
  } catch (e) {
    tts.pause() // drops whatever is queued; end() below then resolves at once
    if (st.speech) await st.speech.end()
    throw e
  }
  onTextEnd() // belt and braces: a stream that never sent text_end still gets spoken

  // what the transcript actually says, not the stream's slicing of it
  const spoken = st.content
    .filter((b): b is Extract<Block, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join(' ')
    .trim()
  if (spoken && st.chatId) useStore.getState().updateChat(st.chatId, { text: spoken })

  if (st.speech) await st.speech.end()
  return st.content
}

async function loop() {
  running = true
  // a turn that errored mid-tool leaves an orphaned tool_use behind in memory too
  messages = repair(messages)
  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      useStore.setState({ agentState: 'thinking' })
      const content = await speakTurn()
      messages.push({ role: 'assistant', content })

      const calls = content.filter(
        (b): b is Extract<Block, { type: 'tool_use' }> => b.type === 'tool_use',
      )
      if (calls.length === 0) break

      // Something said while this turn was in flight beats the tools the turn asked
      // for. Without this, asking a question just as the model decides to read gets
      // you a whole chapter first and an answer after it — the app looking a message
      // behind. tts.pause() only cancels playback that has already started; a
      // read_aloud dispatched *after* the interruption isn't cancelled by anything.
      const results: Block[] = []
      for (const call of calls) {
        results.push(
          pending
            ? { type: 'tool_result', tool_use_id: call.id, content: '[Not run — the user said something first. Deal with that instead.]' }
            : await runTool(call),
        )
      }
      if (awaitingWords) await settle()
      // an interruption belongs in the same user turn as the tool result it cut short
      if (pending) {
        results.push({ type: 'text', text: pending })
        pending = null
      }
      messages.push({ role: 'user', content: results })
    }
  } catch (e) {
    // a failed turn must not leave the panel mid-sentence about what it's doing
    tts.pause()
    useStore.setState({ notice: e instanceof Error ? e.message : String(e) })
  } finally {
    running = false
    useStore.setState({ agentState: 'idle' })
  }

  // something arrived while the loop was winding down
  if (pending) {
    messages.push({ role: 'user', content: pending })
    pending = null
    void loop()
  }
}
