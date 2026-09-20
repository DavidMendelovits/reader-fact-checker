// The conversation loop, once, for both apps.
//
// The conversation is the app. Everything the user says becomes a turn; the agent
// drives playback and the rest of the client through tools it calls back into.
//
// read_aloud is the load-bearing one: it resolves only when the range finishes or
// the user talks over it, so a chapter of narration costs one model round-trip
// rather than one per paragraph. When it comes back interrupted, the interrupting
// utterance rides along in the same user turn as the tool result — that is what
// lets "wait, what was that?" resolve against the text that was just read.
//
// Platform-free on purpose: no React, no expo, no DOM, no zustand, no imports at
// all, so it runs under `node --experimental-strip-types` and bundles in Metro.
// Everything a platform owns — the player, the store, the transport, the tools,
// the navigation kinds only one app has — arrives through `deps`.
//
// Barge-in (plan 3.2A / X2): beginUtterance() HOLDS the player rather than pausing
// it, so a cough never moves the row tint and never resolves read_aloud. The first
// surviving interim or final converts that hold into the real interruption with
// pause(); falseStart() releases it and the book carries on as if nothing happened.

export type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string }
export type Msg = { role: 'user' | 'assistant'; content: string | Block[] }

export type AgentState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'reading'

/** What the player reports back from a range: the phone never produces 'failed'. */
export type PlayOutcome = 'completed' | 'stopped' | 'failed'

/** What to show, and what to tell the model happened. */
export type FastResult = { chat: string; note: string }
/** `spoken` says the line was already read aloud; `quiet` that it is better left unsaid. */
export type NavResult = FastResult & { spoken?: boolean; quiet?: boolean }

/** One flattened paragraph, as much of it as the loop needs. */
export type Paragraph = { text: string; chapterIndex: number }

/**
 * The player, as the loop uses it. Web src/lib/tts.ts is a MediaSource streaming
 * queue and mobile/src/tts.ts wraps expo-speech; they share these names and
 * nothing else (see holdGate.ts — the policy is shared, not the class).
 */
export interface AgentPlayer {
  setParagraphs(paragraphs: string[]): void
  setRate(rate: number): void
  playFrom(from: number, to: number): Promise<PlayOutcome>
  /** The real interruption: cancels the range and abandons any hold. */
  pause(): void
  /** Stop the engine but keep the paragraph, without resolving playFrom. */
  hold(): void
  /** Resume the held paragraph. */
  release(): void
  readonly held: boolean
  /** One-off line, outside any range. */
  speak(text: string): Promise<void>
  readonly currentIndex: number
  readonly recentlySpoken: string
}

/** The store, as the loop uses it. */
export interface AgentStateAccess {
  agentState(): AgentState
  setAgentState(state: AgentState): void
  /** True while document narration is playing — a hold does not clear it. */
  playing(): boolean
  paragraphs(): Paragraph[]
  currentParagraph(): number
  rate(): number
  setRate(rate: number): void
  /** Chapter titles of the open document; empty when nothing is open. */
  chapters(): { title: string }[]
  /** The Composer's in-progress transcript line (plan 1.1A). */
  setInterim(text: string): void
  pushChat(message: { id: string; role: 'user' | 'assistant'; text: string }): void
  updateChat(id: string, patch: { text: string }): void
  setNotice(message: string): void
}

/**
 * One model turn. The phone posts JSON to /api/agent and hands back the blocks;
 * the web streams NDJSON and speaks the reply a sentence at a time as it arrives,
 * so by the time it resolves the reply has been shown and said — that is what
 * `spoken` reports, and why the loop skips its own speaking step for it.
 */
export type TurnResult = { content: Block[]; spoken?: boolean }

export interface AgentDeps<A extends { kind: string }> {
  player: AgentPlayer
  state: AgentStateAccess
  /** The fast navigation decider (navigate.ts). Null means "ask the conversation". */
  decide(text: string, early: boolean): Promise<A | null>
  api(messages: Msg[], context: unknown, extras: Record<string, unknown>): Promise<TurnResult>
  /** The nav kinds only this platform has: mobile open/list/close/file. */
  runNav(action: A): Promise<NavResult>
  /** Platform tools by name. read_aloud, set_speed and the loop itself are shared. */
  tools: Record<string, (input: Record<string, unknown>) => Promise<string> | string>
  buildContext(): unknown
  /** Sent with every request; the phone declares its library tools this way. */
  clientTools?: unknown[]
  clientSystem?: string
  /** The web's earcon: going to the model costs a round-trip of silence. */
  blip?(): void
  newId(): string
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
  /**
   * Ceiling on the stored transcript. The phone's conversation outlives any one
   * document, so it needs one; the web's is bounded by the document it belongs to.
   */
  trimAbove?: number
  trimTo?: number
}

export interface Agent {
  /** Returns the id of the user bubble it posted, so a partial's can be corrected. */
  say(text: string): string | null
  sayInterim(text: string): void
  beginUtterance(): void
  falseStart(): void
  /**
   * Hand the agent the floor. `build` runs only when the turn will actually be
   * taken, so an opening that consumes something (a reopen mark) is not spent on a
   * turn that never happens. Returns whether the cue was accepted.
   */
  openingTurn(build: () => string | null, opts?: { queueWhileRunning?: boolean }): boolean
  resetConversation(): void
  /**
   * The raw tool-use transcript is what actually carries context — the rendered
   * chat log is a lossy view of it — so persistence round-trips this, not the
   * bubbles.
   */
  exportMessages(): Msg[]
  restoreMessages(saved: unknown[]): void
  /** Play a range and hold until it ends or the user talks over it. */
  playRange(from: number, to: number): Promise<PlayOutcome>
  /**
   * Say one short line, then start reading from a paragraph. Exposed for the
   * platform-only nav kinds in deps.runNav (the phone's "Opening {title}.").
   */
  announceAndRead(line: string, from: number): Promise<void>
}

const MAX_TURNS = 12 // backstop against a tool-call loop

/** A transport command heard on a partial, waiting for its final so we can drop it. */
const EARLY_DEDUP_WINDOW = 6000

/** What the line says when the turn died on the network (Pass 2, Agent turn). */
const OFFLINE_LINE = 'Offline. Reading still works.'

/** fetch rejects with a TypeError when the request never left the device. */
const OFFLINE_MESSAGE = /network request failed|failed to fetch|load failed|networkerror/i
/** How both adapters render a status: "/api/agent failed (503): …". 0 is no response at all. */
const OFFLINE_STATUS = /\((?:0|50[234])\)/

/**
 * Was this the network, rather than us? Gateways and timeouts (502/503/504) count:
 * the reader is just as offline from a proxy that never reached the model.
 */
function isOffline(e: unknown): boolean {
  if (e instanceof TypeError) return true
  const status = (e as { status?: unknown } | null | undefined)?.status
  if (typeof status === 'number' && (status === 0 || (status >= 502 && status <= 504))) return true
  const message = e instanceof Error ? e.message : String(e)
  return OFFLINE_MESSAGE.test(message) || OFFLINE_STATUS.test(message)
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

export const normalize = (text: string) => text.toLowerCase().replace(/[.!,?]+$/, '').trim()

/** The nav kinds both apps share; anything else goes to deps.runNav. */
type SharedNav =
  | { kind: 'chapter'; index: number }
  | { kind: 'next_chapter' }
  | { kind: 'previous_chapter' }
  | { kind: 'beginning' }
  | { kind: 'pause' }
  | { kind: 'resume' }

const SHARED_NAV_KINDS = ['chapter', 'next_chapter', 'previous_chapter', 'beginning', 'pause', 'resume']

/** Patched in under every orphaned tool_use before sending; see repair(). */
const INTERRUPTED_RESULT = '[Interrupted — the app was closed or reloaded before this finished.]'

/**
 * A transcript can end up with a tool_use no tool_result ever answered — a reload
 * mid-read_aloud persists exactly that, and a fast-path append lands plain text
 * after it. The API rejects the whole conversation then, so patch in a synthetic
 * result for every orphaned call before sending.
 */
export function repair(msgs: Msg[]): Msg[] {
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
          type: 'tool_result', tool_use_id: call.id, content: INTERRUPTED_RESULT,
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
          type: 'tool_result', tool_use_id: call.id, content: INTERRUPTED_RESULT,
        })),
      })
    }
  }
  return out
}

/**
 * Keep the transcript bounded. Drops the oldest messages once it grows past
 * `above`, then makes the head valid again: the first message must be from the
 * user, and a tool_result whose tool_use was just dropped has to go too.
 */
export function trim(msgs: Msg[], above = Infinity, to = Infinity): Msg[] {
  let out = msgs.length > above ? msgs.slice(-to) : msgs
  out = repair(out)
  while (out.length > 0) {
    const head = out[0]
    if (head.role !== 'user') { out = out.slice(1); continue }
    if (Array.isArray(head.content)) {
      const kept = head.content.filter((b) => b.type !== 'tool_result')
      if (kept.length === 0) { out = out.slice(1); continue }
      head.content = kept
    }
    break
  }
  return out
}

export function createAgent<A extends { kind: string }>(deps: AgentDeps<A>): Agent {
  const player = deps.player
  const state = deps.state
  const trimAbove = deps.trimAbove ?? Infinity
  const trimTo = deps.trimTo ?? Infinity

  let messages: Msg[] = []
  let running = false
  let pending: string | null = null
  let awaitingWords = false // speech started; transcript not in yet

  /** Set while a turn is in flight and the app has already done what the interruption asked. */
  let interruptionHandled: string | null = null

  // A partial transcript is asked about as it grows, debounced; only the newest
  // answer counts, and only if the final hasn't already arrived.
  let interimTimer: unknown = null
  let interimSeq = 0
  let lastInterim = ''

  /**
   * A transport command heard on a partial transcript, waiting for its final to show
   * up so we can drop it. Time-boxed: a final that never arrives must not swallow the
   * next real "pause" minutes later.
   */
  let handledEarly: { text: string; at: number; chatId: string | null; early?: boolean } | null = null

  /** Nothing is happening unless a turn is in flight, in which case we're thinking. */
  const restState = (): AgentState => (running ? 'thinking' : 'idle')

  // ---- the read_aloud tool ----

  /**
   * Play a range and hold until it ends or the user talks over it. Shared by the
   * read_aloud tool and the "keep going" fast path.
   */
  async function playRange(from: number, to: number): Promise<PlayOutcome> {
    const paragraphs = state.paragraphs()
    player.setParagraphs(paragraphs.map((p) => p.text))
    player.setRate(state.rate())
    state.setAgentState('reading') // `playing` is driven by the player's onPlayingChange
    const outcome = await player.playFrom(from, to)
    // Playback is over the moment playFrom returns. Leaving the state on 'reading'
    // through the settle window and the next model turn made the UI claim it was
    // still reading for seconds after the audio stopped.
    state.setAgentState(running ? 'thinking' : 'idle')
    if (outcome === 'failed')
      state.setNotice('Narration failed — the speech service is unreachable. Your position is saved.')
    return outcome
  }

  async function readAloud(input: Record<string, unknown>): Promise<string> {
    const paragraphs = state.paragraphs()
    if (paragraphs.length === 0) return 'No document is loaded.'
    const last = paragraphs.length - 1
    const clamp = (n: number) => Math.max(0, Math.min(last, n))
    const from = Number.isInteger(input.from) ? clamp(input.from as number) : clamp(state.currentParagraph())
    const to = Number.isInteger(input.to) ? clamp(input.to as number) : last

    const outcome = await playRange(from, to)
    const stoppedAt = player.currentIndex
    if (outcome === 'failed')
      return `Narration failed — the speech service is unreachable, so nothing past paragraph ${stoppedAt} was read. The user has been shown an error. Do not retry read_aloud this turn.`
    return outcome === 'completed'
      ? `Read paragraphs ${from} through ${to}. Position is now paragraph ${Math.min(to + 1, last)}.`
      : `The user interrupted at paragraph ${stoppedAt}, which reads: "${paragraphs[stoppedAt]?.text ?? ''}"`
  }

  function setSpeed(input: Record<string, unknown>): string {
    const rate = Math.max(0.5, Math.min(3, Number(input.rate) || 1))
    state.setRate(rate)
    player.setRate(rate)
    return `Playback speed is now ${rate}x.`
  }

  async function runTool(block: Extract<Block, { type: 'tool_use' }>): Promise<Block> {
    let content: string
    try {
      if (block.name === 'read_aloud') content = await readAloud(block.input)
      else if (block.name === 'set_speed') content = setSpeed(block.input)
      else {
        const tool = deps.tools[block.name]
        content = tool ? await tool(block.input) : `Unknown tool: ${block.name}`
      }
    } catch (e) {
      // a tool that throws (not signed in, say) is a result for the model, not the end of the turn
      content = `The tool failed: ${e instanceof Error ? e.message : String(e)}`
    }
    return { type: 'tool_result', tool_use_id: block.id, content }
  }

  // ---- fast-path commands ----

  /**
   * Matches without doing anything, so a partial transcript can be tested before we
   * decide to act on it. Returns the action to run, or null to defer to the model.
   */
  function matchFast(text: string): (() => FastResult) | null {
    const t = normalize(text)
    if (t.split(/\s+/).length > 6) return null

    if (PAUSE.test(t)) {
      return () => {
        player.pause() // flips store.playing through the player's onPlayingChange
        return { chat: 'Paused.', note: 'Paused playback.' }
      }
    }

    // Mid-loop, resuming is the model's call — a second playback started underneath a
    // read_aloud that's still awaiting would fight it for the player.
    if (RESUME.test(t) && !running) {
      const paragraphs = state.paragraphs()
      if (paragraphs.length === 0) return null
      const from = Math.min(state.currentParagraph(), paragraphs.length - 1)
      return () => {
        void playRange(from, state.paragraphs().length - 1)
        return { chat: 'Reading.', note: `Resumed reading from paragraph ${from}.` }
      }
    }

    const named = NAMED_RATES[t]
    const numeric = t.match(NUMERIC_RATE)
    let rate: number | null = null
    if (FASTER.test(t)) rate = state.rate() + 0.25
    else if (SLOWER.test(t)) rate = state.rate() - 0.25
    else if (typeof named === 'number') rate = named
    else if (numeric) rate = Number(numeric[1])
    if (rate != null) {
      const r = rate
      return () => {
        const note = setSpeed({ rate: r }) // clamps and updates the store and the player
        return { chat: `${state.rate()}x.`, note }
      }
    }

    return null
  }

  /** Runs the command if the utterance is only that; returns null to defer to the model. */
  const fastCommand = (text: string): FastResult | null => matchFast(text)?.() ?? null

  // ---- fast navigation (see navigate.ts): a decision, then one of these ----

  /** The first paragraph of a chapter, by index into doc.chapters. */
  function chapterStart(index: number): number {
    const i = state.paragraphs().findIndex((p) => p.chapterIndex === index)
    return i < 0 ? 0 : i
  }

  /** Say one short line, then start reading from a paragraph. */
  async function announceAndRead(line: string, from: number) {
    const before = state.paragraphs().length
    if (line) {
      state.pushChat({ id: deps.newId(), role: 'assistant', text: line })
      state.setAgentState('speaking')
      await player.speak(line)
    }
    const last = state.paragraphs().length - 1
    void playRange(Math.min(from, before - 1), last)
  }

  /**
   * Carry out a navigation decision. Returns what to show, and what to tell the
   * model happened, the way the fast-path commands do; `spoken` says the line
   * was already read aloud (so the caller doesn't post it twice).
   */
  async function runNav(action: A): Promise<NavResult> {
    if (!SHARED_NAV_KINDS.includes(action.kind)) return deps.runNav(action)
    // one cast, guarded by the list above: the shared kinds have the shared shapes
    const nav = action as unknown as SharedNav
    const paragraphs = state.paragraphs()
    const chapters = state.chapters()
    switch (nav.kind) {
      case 'chapter': {
        const title = chapters[nav.index]?.title ?? `chapter ${nav.index + 1}`
        await announceAndRead(`${title}.`, chapterStart(nav.index))
        return { chat: `${title}.`, note: `Jumped to "${title}" and started reading there.`, spoken: true }
      }
      case 'next_chapter':
      case 'previous_chapter': {
        const at = paragraphs[Math.min(state.currentParagraph(), paragraphs.length - 1)]
        const here = at?.chapterIndex ?? 0
        // "back a chapter" from deep inside one means the start of this one
        const target = nav.kind === 'next_chapter' ? here + 1 : state.currentParagraph() > chapterStart(here) + 2 ? here : here - 1
        if (target < 0 || target >= chapters.length) {
          const chat = target < 0 ? 'This is the first chapter.' : 'That was the last chapter.'
          return { chat, note: chat }
        }
        const title = chapters[target].title
        await announceAndRead(`${title}.`, chapterStart(target))
        return { chat: `${title}.`, note: `Jumped to "${title}" and started reading there.`, spoken: true }
      }
      case 'beginning':
        await announceAndRead('From the top.', 0)
        return { chat: 'From the top.', note: 'Started the document over from the beginning.', spoken: true }
      case 'pause':
        player.pause()
        return { chat: 'Paused.', note: 'Paused playback.', quiet: true }
      case 'resume': {
        if (paragraphs.length === 0) return { chat: 'Nothing is open to read.', note: 'No document is open.' }
        const from = Math.min(state.currentParagraph(), paragraphs.length - 1)
        void playRange(from, paragraphs.length - 1)
        return { chat: 'Reading.', note: `Resumed reading from paragraph ${from}.`, quiet: true }
      }
    }
  }

  /** Show the outcome, and say it unless it was said already or is better left silent ("Paused."). */
  async function deliver(result: NavResult) {
    if (result.spoken) return
    state.pushChat({ id: deps.newId(), role: 'assistant', text: result.chat })
    if (result.quiet) return
    state.setAgentState('speaking')
    await player.speak(result.chat)
  }

  /** The action is done outside a turn: let the model know the way the fast path does. */
  async function recordNav(text: string, result: NavResult) {
    await deliver(result)
    messages.push({ role: 'user', content: text })
    messages.push({ role: 'assistant', content: result.note })
  }

  /**
   * The action is done over a turn in flight: the loop hears about it with the
   * tool results it is about to send — and then ends the turn without asking the
   * model anything, because the interruption has been dealt with. What was
   * asked for is happening; a model reply on top of it would only talk over it.
   */
  async function recordOverTurn(text: string, result: NavResult) {
    await deliver(result)
    const done = `${text} [the app already did this: ${result.note}]`
    pending = pending ? `${pending} ${done}` : done
    interruptionHandled = result.note
  }

  /**
   * The reader has finished a sentence that no local command matched: ask the
   * decision model first, and only then the conversation. `running` holds for the
   * whole of it so a second utterance queues behind, as it would behind a turn.
   */
  async function decideThenLoop(text: string) {
    running = true
    state.setAgentState('thinking')
    const action = await deps.decide(text, false)
    if (action) {
      await recordNav(text, await runNav(action))
      running = false
      if (state.agentState() === 'thinking') state.setAgentState('idle')
      flushPending()
      return
    }
    messages.push({ role: 'user', content: text })
    await loop()
  }

  /**
   * Something said over a turn in flight — the interruption path. The voice has
   * already stopped (say() did that); this decides what the words meant while
   * the loop's settle() holds for them, and hands the loop the outcome the way
   * the fast-path commands do, so the model hears what happened rather than
   * being asked to make it happen.
   */
  async function decideWhileRunning(text: string) {
    awaitingWords = true // keep settle() waiting on the decision, not just the words
    const action = await deps.decide(text, false)
    if (action) {
      const result = await runNav(action)
      if (running) await recordOverTurn(text, result)
      else await recordNav(text, result) // the turn ended while we decided
    } else {
      pending = pending ? `${pending} ${text}` : text
    }
    awaitingWords = false
    flushPending()
  }

  /** Whatever queued while a turn was in flight starts the next one — if no turn is running any more. */
  function flushPending() {
    if (running || !pending) return
    const next = pending
    pending = null
    messages.push({ role: 'user', content: next })
    if (interruptionHandled) {
      // the turn ended before it could carry the note; nothing to ask the model
      messages.push({ role: 'assistant', content: interruptionHandled })
      interruptionHandled = null
      return
    }
    void loop()
  }

  function decideEarly(raw: string, normalized: string) {
    const seq = ++interimSeq
    void deps.decide(raw, true).then(async (action) => {
      if (!action || seq !== interimSeq) return
      if (handledEarly && deps.now() - handledEarly.at < EARLY_DEDUP_WINDOW) return
      handledEarly = { text: normalized, at: deps.now(), chatId: null, early: true }
      const chatId = deps.newId()
      handledEarly.chatId = chatId
      const text = raw.trim()
      state.pushChat({ id: chatId, role: 'user', text })
      if (running) {
        // over a turn: the reading has stopped already; act, and tell the loop.
        // settle() keeps holding (awaitingWords) until the note is in place.
        const result = await runNav(action)
        if (running) await recordOverTurn(text, result)
        else await recordNav(text, result)
        awaitingWords = false
        flushPending()
        return
      }
      awaitingWords = false
      running = true
      state.setAgentState('thinking')
      try {
        await recordNav(text, await runNav(action))
      } finally {
        running = false
        if (state.agentState() === 'thinking') state.setAgentState('idle')
      }
      flushPending()
    })
  }

  // ---- turn loop ----

  /**
   * The user has started talking. The narration is HELD rather than paused: the
   * engine stops within ~160ms of the first loud level report, but the paragraph
   * and `playing` stay put, so a cough costs nothing — falseStart() releases it
   * and the row tint never moved. It becomes a real interruption only once words
   * survive (see sayInterim/say). This replaces the old 5s listenTimer.
   */
  function beginUtterance() {
    awaitingWords = true
    player.hold()
    state.setAgentState('listening')
  }

  /**
   * It was a cough. Resume the held paragraph and put the state back where it was:
   * still reading if the player is in a range, otherwise the rest state.
   */
  function falseStart() {
    player.release()
    state.setInterim('')
    awaitingWords = false
    if (state.agentState() === 'listening') state.setAgentState(state.playing() ? 'reading' : restState())
  }

  /**
   * The hold beginUtterance() took becomes the real interruption now that words
   * have survived: pause() abandons the hold, which is what resolves the parked
   * read_aloud as 'stopped'. Returns whether it did the pausing, so a caller that
   * would pause again doesn't.
   */
  function convertHold(): boolean {
    if (!player.held) return false
    player.pause()
    return true
  }

  /**
   * Act on a partial transcript when it can only mean one thing. The recognizer
   * finalizes an utterance a beat after you stop talking, which is a long time to
   * keep reading at someone who said "stop". Anything less clear-cut waits for the
   * final, where we know what was actually said.
   */
  function sayInterim(text: string) {
    const t = normalize(text)
    if (!t) return
    state.setInterim(text) // the Composer's line shows the words as they come (1.1A)
    convertHold()
    if (matchFast(t)) {
      // One early command per utterance. A partial arrives several times as it grows,
      // and "stop" then "stop reading" are the same instruction twice.
      if (handledEarly && deps.now() - handledEarly.at < EARLY_DEDUP_WINDOW) return
      // A partial is a prefix, so the bubble this posts shows a truncated version of
      // what the user is still saying. say() corrects it in place once the final lands.
      //
      // The record is written *after* say(), not before: say() dedups against
      // whatever handledEarly holds, so setting it first made every partial command
      // dedup against itself and do nothing at all.
      const chatId = say(text)
      handledEarly = { text: t, at: deps.now(), chatId }
      return
    }
    // Not a bare command: ask the decision model as the words come in, so "skip to
    // chapter three" — or "open the Hemingway one" — can be happening before the
    // recognizer decides the reader has finished. One ask per change, a beat after it.
    if (t === lastInterim || t.split(/\s+/).length < 2) return
    if (handledEarly && deps.now() - handledEarly.at < EARLY_DEDUP_WINDOW) return
    lastInterim = t
    if (interimTimer !== null) deps.clearTimeout(interimTimer)
    interimTimer = deps.setTimeout(() => decideEarly(text, t), 250)
  }

  /**
   * Hand the agent something the user said. While a turn is already in flight this
   * cancels playback instead of queueing — that *is* the interruption path.
   */
  function say(text: string): string | null {
    const trimmed = text.trim()
    if (!trimmed) return null
    const paused = convertHold()
    state.setInterim('')
    // The final for something already run off its partial. Partials grow as prefixes,
    // so "stop" finalizing as "stop reading" is still the same command — drop it. A
    // final that grew into something more than a command ("stop, go back to chapter
    // two") falls through to the model, which is what should handle it; the pause it
    // already ran is in the transcript, so acting again is at worst a no-op.
    const early = handledEarly
    handledEarly = null
    if (interimTimer !== null) deps.clearTimeout(interimTimer)
    interimTimer = null
    interimSeq++ // whatever the partial was asking is moot now
    lastInterim = ''
    if (early && deps.now() - early.at < EARLY_DEDUP_WINDOW) {
      const n = normalize(trimmed)
      // the final of something already done off its partial: a command, or a
      // navigation the decider was sure of. The bubble gets the words as said.
      if ((n === early.text || n.startsWith(`${early.text} `)) && (early.early || matchFast(n))) {
        if (early.chatId) state.updateChat(early.chatId, { text: trimmed })
        awaitingWords = false
        return early.chatId
      }
    }
    awaitingWords = false
    const chatId = deps.newId()
    state.pushChat({ id: chatId, role: 'user', text: trimmed })
    if (state.agentState() === 'listening') state.setAgentState(restState())

    // Handled here and now; the model finds out from the transcript on its next turn.
    const fast = fastCommand(trimmed)
    if (fast) {
      state.pushChat({ id: deps.newId(), role: 'assistant', text: fast.chat })
      if (running) {
        // rides along with the tool result the loop is about to send, so roles alternate
        const done = `${trimmed} [the app already did this: ${fast.note}]`
        pending = pending ? `${pending} ${done}` : done
        interruptionHandled = fast.note
      } else {
        messages.push({ role: 'user', content: trimmed })
        messages.push({ role: 'assistant', content: fast.note })
      }
      return chatId
    }

    // Going to the model costs a round-trip of silence. Mark the hand-off so the user
    // knows they were heard — but not over the agent's own reply, where the voice
    // stopping mid-word is already the acknowledgment.
    if (state.agentState() !== 'speaking') deps.blip?.()

    if (running) {
      // the interruption itself: instant, before anything is decided; resolves any
      // in-flight read_aloud as 'stopped'. convertHold() may already have done it.
      if (!paused) player.pause()
      void decideWhileRunning(trimmed)
      return chatId
    }
    void decideThenLoop(trimmed)
    return chatId
  }

  function openingTurn(build: () => string | null, opts: { queueWhileRunning?: boolean } = {}): boolean {
    if (running && !opts.queueWhileRunning) return false
    const cue = build()
    if (!cue) return false
    if (running) {
      // a tap mid-turn: the loop picks it up as the next thing the reader "said"
      pending = pending ? `${pending} ${cue}` : cue
      return true
    }
    messages.push({ role: 'user', content: cue })
    void loop()
    return true
  }

  /** Give a half-spoken utterance time to finalize before we act on the interruption. */
  async function settle(ms = 3000) {
    const deadline = deps.now() + ms
    while (awaitingWords && !pending && deps.now() < deadline) {
      await new Promise<void>((r) => { deps.setTimeout(r, 100) })
    }
    awaitingWords = false
    if (state.agentState() === 'listening') state.setAgentState('thinking')
  }

  async function loop() {
    running = true
    try {
      for (let turn = 0; turn < MAX_TURNS; turn++) {
        // Bounded and made sendable every turn: a turn that errored mid-tool leaves
        // an orphaned tool_use behind in memory too.
        messages = trim(messages, trimAbove, trimTo)
        state.setAgentState('thinking')

        const extras: Record<string, unknown> = {}
        if (deps.clientTools) extras.clientTools = deps.clientTools
        if (deps.clientSystem) extras.clientSystem = deps.clientSystem
        const result = await deps.api(messages, deps.buildContext(), extras)
        const content = result.content
        messages.push({ role: 'assistant', content })

        // The web's transport streams the reply and speaks it a sentence at a time
        // as it arrives, so by here it has already been shown and said.
        if (!result.spoken) {
          const spoken = content
            .filter((b): b is Extract<Block, { type: 'text' }> => b.type === 'text')
            .map((b) => b.text)
            .join(' ')
            .trim()
          if (spoken) {
            state.pushChat({ id: deps.newId(), role: 'assistant', text: spoken })
            state.setAgentState('speaking')
            await player.speak(spoken)
          }
        }

        const calls = content.filter(
          (b): b is Extract<Block, { type: 'tool_use' }> => b.type === 'tool_use',
        )
        if (calls.length === 0) break

        // Something said while this turn was in flight beats the tools the turn asked
        // for. Without this, asking a question just as the model decides to read gets
        // you a whole chapter first and an answer after it — the app looking a message
        // behind. pause() only cancels playback that has already started; a read_aloud
        // dispatched *after* the interruption isn't cancelled by anything.
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
        if (interruptionHandled) {
          // the app did what the interruption asked; nothing to ask the model.
          // Its side of the exchange is the note, so the history still alternates.
          messages.push({ role: 'assistant', content: interruptionHandled })
          interruptionHandled = null
          break
        }
      }
    } catch (e) {
      // a failed turn must not leave the panel mid-sentence about what it's doing
      player.pause()
      // Losing the network mid-turn is not an error the reader did anything about,
      // and the book itself is on the device: say so in the line and let them carry
      // on reading. Everything else is a real fault and still gets the toast.
      if (isOffline(e)) state.pushChat({ id: deps.newId(), role: 'assistant', text: OFFLINE_LINE })
      else state.setNotice(e instanceof Error ? e.message : String(e))
    } finally {
      running = false
      // a turn that ended with the app already reading (an interruption it handled) is still reading
      state.setAgentState(state.playing() ? 'reading' : 'idle')
    }

    // something arrived while the loop was winding down
    flushPending()
  }

  return {
    say,
    sayInterim,
    beginUtterance,
    falseStart,
    openingTurn,
    resetConversation() {
      messages = []
      pending = null
    },
    announceAndRead,
    exportMessages: () => messages,
    restoreMessages(saved: unknown[]) {
      messages = repair((saved as Msg[]) ?? [])
    },
    playRange,
  }
}
