// The browser's half of the agent. The conversation loop itself lives in
// shared/voice/agent.ts (T18) — turn loop, fast paths, decide-then-loop, the
// pending/interruptionHandled dance, the hold that barge-in converts into a real
// interruption. This file is the adapter: it says what a player, a store, a
// transport and a tool are on this platform, and re-exports the same functions
// controller.ts, persist.ts and the Composer have always imported.
//
// The conversation is the app. Everything the user says becomes a turn; the agent
// drives playback and fact-checking through tools it calls back into the client.
//
// read_aloud is the load-bearing one: it resolves only when the range finishes or
// the user talks over it, so a chapter of narration costs one model round-trip
// rather than one per paragraph. When it comes back interrupted, the interrupting
// utterance rides along in the same user turn as the tool result — that is what
// lets "wait, what was that?" resolve against the text that was just read.
import { useStore } from '../store'
import type { SpeechStream } from './tts'
import { tts } from './providers'
import { checkPassage, completeField } from './factcheck'
import { blip } from './earcon'
import { apiNdjson, isTransient, RETRY_WAITS } from './api'
import { SentenceSplitter } from './sentences'
import { decide, type NavAction } from './navigate'
import type { Doc, FactCheckJob, Highlight } from '../types'
import { createAgent, type AgentPlayer, type Block, type Msg, type NavResult } from '../../shared/voice/agent'

let reopenedAt: number | null = null // set by persist when a saved entry is reopened

let jobCounter = 0
const newId = () => `job-${Date.now()}-${++jobCounter}`

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

// ---- client-side tools (read_aloud and set_speed live in the loop) ----

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

// ---- the transport: one model turn, spoken as it streams ----

type AgentLine =
  | { type: 'text'; text: string }
  | { type: 'text_end' }
  | { type: 'done'; content: Block[] }
  | { type: 'error'; error: string }

/**
 * The reply goes to the synthesizer a sentence at a time, so the first one is
 * playing while the model is still writing the rest — and the tool call after it,
 * which is the part that used to hold "let me check that" hostage: the whole
 * fact_check argument had to finish generating before a byte of the reply reached
 * the voice.
 *
 * Resolves with the full content once the reply has been *spoken*, not just
 * received — which is why the loop is told `spoken: true` and skips its own
 * speaking step. Tools run after that, same as before: read_aloud and the next
 * tts.speak() both take the player, and would cut the reply off mid-word.
 */
async function speakTurn(messages: Msg[], context: unknown, extras: Record<string, unknown>): Promise<Block[]> {
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
    // Retried on transient failures (429/5xx/network): one 529 must not end the
    // conversation. Only while nothing has been spoken yet — a stream that dies
    // mid-sentence has already been heard, and a replay would say it twice.
    for (let attempt = 0; ; attempt++) {
      try {
        await apiNdjson<AgentLine>('/api/agent-stream', { messages, context, ...extras }, (msg) => {
          if (msg.type === 'text') onText(msg.text)
          else if (msg.type === 'text_end') onTextEnd()
          else if (msg.type === 'done') st.content = msg.content
          else throw new Error(msg.error)
        })
        break
      } catch (e) {
        if (st.sofar || attempt >= RETRY_WAITS.length || !isTransient(e)) throw e
        await new Promise((r) => setTimeout(r, RETRY_WAITS[attempt]))
      }
    }
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

// ---- the loop ----

const agent = createAgent<NavAction>({
  player: {
    setParagraphs: (paragraphs) => tts.setParagraphs(paragraphs),
    setRate: (rate) => tts.setRate(rate),
    playFrom: (from, to) => tts.playFrom(from, to),
    pause: () => tts.pause(),
    hold: () => tts.hold(),
    release: () => tts.release(),
    get held() { return tts.held },
    speak: (text) => tts.speak(text),
    get currentIndex() { return tts.currentIndex },
    get recentlySpoken() { return tts.recentlySpoken },
  } satisfies AgentPlayer,
  state: {
    agentState: () => useStore.getState().agentState,
    setAgentState: (agentState) => useStore.setState({ agentState }),
    playing: () => useStore.getState().playing,
    paragraphs: () => useStore.getState().paragraphs,
    currentParagraph: () => useStore.getState().currentParagraph,
    rate: () => useStore.getState().rate,
    setRate: (rate) => useStore.getState().setRate(rate),
    chapters: () => useStore.getState().doc?.chapters ?? [],
    setInterim: (interim) => useStore.getState().setInterim(interim),
    pushChat: (m) => useStore.getState().pushChat(m),
    updateChat: (id, patch) => useStore.getState().updateChat(id, patch),
    setNotice: (notice) => useStore.setState({ notice }),
  },
  decide: (text, early) => decide(text, early),
  api: async (messages, context, extras) => ({ content: await speakTurn(messages, context, extras), spoken: true }),
  // Every nav kind the browser decider can return is one the shared loop handles
  // itself (chapter, next, previous, beginning, pause, resume) — the library kinds
  // are the phone's. Nothing routes here.
  runNav: async (action): Promise<NavResult> => ({ chat: '', note: `Nothing to do for ${action.kind}.`, spoken: true }),
  tools: { fact_check: factCheck, find_in_document: findInDocument, highlight },
  buildContext,
  blip,
  newId,
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
})

// a new document is a new conversation
useStore.subscribe((s, prev) => {
  if (s.doc !== prev.doc) {
    agent.resetConversation()
    // openEntry marks the reopen *after* setDoc, so this only clears a stale mark
    reopenedAt = null
  }
})

// The raw tool-use transcript is what actually carries context — the rendered chat
// log is a lossy view of it — so persistence round-trips this, not the bubbles.
export const exportMessages = (): unknown[] => agent.exportMessages()
export function restoreMessages(saved: unknown[]) {
  agent.restoreMessages(saved)
}

/**
 * The user has started talking. The narration is held rather than paused, so a
 * cough costs nothing; the first surviving word turns it into a real interruption.
 */
export const beginUtterance = () => agent.beginUtterance()

/** The level gate held the narration and no words came: resume it (3.2A / X2). */
export const falseStart = () => agent.falseStart()

/**
 * Act on a partial transcript when it can only mean one thing. Chrome finalizes an
 * utterance a beat after you stop talking, which is a long time to keep reading at
 * someone who said "stop".
 */
export const sayInterim = (text: string) => agent.sayInterim(text)

/**
 * Hand the agent something the user said. Returns the id of the user bubble it
 * posted, so a partial's can be corrected.
 */
export const say = (text: string): string | null => agent.say(text)

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
 *
 * The cue is built only if the turn will be taken, so a reopen mark is never spent
 * on an opening that a turn already in flight refuses.
 */
export function openingTurn() {
  agent.openingTurn(() => {
    const reopened = reopenedAt
    reopenedAt = null // whatever happens here, this open is spent

    if (reopened != null) {
      const gap = Date.now() - reopened
      const at = useStore.getState().currentParagraph
      return gap > STALE_AFTER
        ? `[The reader is back after ${humanGap(gap)} — they last left off at paragraph ${at}. Give a one-breath spoken recap of where the story stands, then continue reading from there.]`
        : '[The reader just reopened this document. Pick up reading from the current position.]'
    }
    if (agent.exportMessages().length === 0)
      return '[The reader just opened this document and is listening. Take it from here.]'
    return null // a conversation already in flight and nothing new to say
  })
}
