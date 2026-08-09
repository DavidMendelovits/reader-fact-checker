// Wires voice ⇄ TTS ⇄ agent ⇄ store. Plain module, no React.
//
// Live interaction runs through the agent conversation (lib/agent.ts). The manual
// transport controls and the whole-document scan stay direct: a play button should
// not need a model round-trip, and a batch scan is a job, not a conversation.
import { useStore } from '../store'
import { tts } from './tts'
import { voice } from './voice'
import { beginUtterance, openingTurn, say } from './agent'
import { startMicMeter, stopMicMeter } from './audio-levels'
import { checkPassage, completeField, extractClaims } from './factcheck'
import type { FactCheckJob, Highlight } from '../types'

let jobCounter = 0
const newId = () => `job-${Date.now()}-${++jobCounter}`

// ---- manual playback ----

export function play(fromIndex?: number) {
  const s = useStore.getState()
  const start = fromIndex ?? s.currentParagraph
  tts.setParagraphs(s.paragraphs.map((p) => p.text))
  tts.setRate(s.rate)
  void tts.playFrom(start)
}

export function pause() {
  tts.pause()
}

tts.onParagraphChange = (i) => useStore.setState({ currentParagraph: i })

// Keep the phone's screen awake while narrating — iOS suspends a locked web page's
// JS, so playback dies with the screen. Wake lock is the web's only lever here.
// ponytail: true lock-screen playback needs a native wrapper or one continuous
// audio stream + Media Session; wake lock covers the read-along use.
let wakeLock: WakeLockSentinel | null = null
async function setWakeLock(on: boolean) {
  try {
    if (on && !wakeLock && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock?.request('screen')
      wakeLock?.addEventListener('release', () => { wakeLock = null })
    } else if (!on) {
      await wakeLock?.release()
      wakeLock = null
    }
  } catch { /* unsupported or denied (e.g. low battery) — narration still works */ }
}
// the OS releases the lock whenever the tab is hidden; take it back on return
document.addEventListener('visibilitychange', () => {
  if (useStore.getState().playing) void setWakeLock(true)
})

// Single source of truth for the header's Play/Pause button: whatever the player is
// actually doing, whoever started it.
tts.onPlayingChange = (playing) => {
  useStore.setState({ playing })
  void setWakeLock(playing)
}
tts.onEnded = () => useStore.setState({ playing: false })
// The agent's own replies are short, so mute rather than trust the echo filter with
// them — a filter miss there would have the agent answering itself in a loop.
tts.onSpeakingChange = (speaking) => voice.setMuted(speaking)

// ---- voice input ----
//
// No wake word: the mic stays live during narration so you can simply talk over it.
// voice.isEcho() drops the recognizer's transcription of the narration itself.
voice.onUtterance = (text) => say(text)
voice.onSpeechStart = () => beginUtterance()
voice.getSpokenText = () => tts.speaking
voice.onError = (msg) => {
  useStore.setState({ micEnabled: false, notice: msg })
}

export function setMicEnabled(enabled: boolean) {
  useStore.setState({ micEnabled: enabled, micMuted: false })
  voice.setUserMuted(false)
  if (enabled) {
    voice.start()
    void startMicMeter()
  } else {
    voice.stop()
    stopMicMeter()
  }
}

/** Drop what the mic hears without tearing down recognition — unmuting is instant. */
export function setMicMuted(muted: boolean) {
  useStore.setState({ micMuted: muted })
  voice.setUserMuted(muted)
}

// Voice-first: opening a document hands the floor to the agent rather than waiting
// for Play. The click that opened it is the user gesture audio playback needs.
//
// Deferred a tick so a restored document's saved conversation and reopen mark are
// back in place first — openingTurn() greets a new document, recaps a reopened one,
// and no-ops when there's a conversation already running.
useStore.subscribe((s, prev) => {
  if (!s.doc || s.doc === prev.doc) return
  setTimeout(() => {
    if (!useStore.getState().micEnabled) setMicEnabled(true)
    openingTurn()
  }, 0)
})

/** Debug hook: drive the agent without a microphone. */
export function simulateUtterance(text: string) {
  say(text)
}

// ---- highlight flow ----

/** Save a selection as a highlight, with no fact check attached. */
export function highlightSelection(text: string, anchor?: number, note?: string): Highlight {
  const h: Highlight = {
    id: newId(),
    anchor: anchor ?? useStore.getState().currentParagraph,
    text,
    note,
    createdAt: Date.now(),
  }
  useStore.getState().addHighlight(h)
  return h
}

export function checkSelection(text: string, anchor?: number) {
  const s = useStore.getState()
  const context = anchor != null ? s.paragraphs[anchor]?.text : undefined
  const passage = context && context !== text ? `${text}\n\n(Surrounding context: ${context})` : text
  // Checking a passage is also an act of marking it — the highlight is the thing
  // that survives, and it's what the hover card in the reader hangs off.
  const h = highlightSelection(text, anchor)
  const job: FactCheckJob = {
    id: newId(), kind: 'highlight', status: 'running',
    excerpt: text.slice(0, 200), anchor, highlightId: h.id, createdAt: Date.now(),
  }
  s.addJob(job)

  let spoken = false
  void checkPassage(passage, (raw) => {
    useStore.getState().updateJob(job.id, { partial: raw })
    // Say the verdict the moment that field closes, rather than after the sources
    // and the rest of the object. Never over the narration — that's an interruption
    // the user didn't ask for.
    if (spoken || useStore.getState().playing) return
    const line = completeField(raw, 'spokenSummary')
    if (line) {
      spoken = true
      void tts.speak(line)
    }
  })
    .then((result) => useStore.getState().updateJob(job.id, { status: 'done', result }))
    .catch((e) => useStore.getState().updateJob(job.id, { status: 'error', error: String(e) }))
}

// ---- whole-document flow ----

let docCheckCancelled = false

export function cancelDocumentCheck() {
  docCheckCancelled = true
  useStore.getState().setDocCheckProgress(null)
}

export async function checkWholeDocument() {
  const s = useStore.getState()
  if (s.paragraphs.length === 0 || s.docCheckProgress) return
  docCheckCancelled = false

  // chunk into ~2000-word sections, remembering each section's starting paragraph
  const sections: { text: string; anchor: number }[] = []
  let buf: string[] = []
  let words = 0
  let anchor = 0
  s.paragraphs.forEach((p, i) => {
    if (buf.length === 0) anchor = i
    buf.push(p.text)
    words += p.text.split(/\s+/).length
    if (words >= 2000) {
      sections.push({ text: buf.join('\n\n'), anchor })
      buf = []
      words = 0
    }
  })
  if (buf.length) sections.push({ text: buf.join('\n\n'), anchor })

  s.setDocCheckProgress({ done: 0, total: sections.length })

  // gather claims per section, then check claims with limited parallelism
  const claims: { claim: string; anchor: number }[] = []
  for (const [i, section] of sections.entries()) {
    if (docCheckCancelled) return
    try {
      for (const c of await extractClaims(section.text)) claims.push({ claim: c, anchor: section.anchor })
    } catch (e) {
      console.error('claim extraction failed for section', i, e)
    }
    useStore.getState().setDocCheckProgress({ done: i + 1, total: sections.length + claims.length })
  }

  const total = sections.length + claims.length
  let done = sections.length
  const CONCURRENCY = 3
  const queue = [...claims]

  async function worker() {
    for (;;) {
      const item = queue.shift()
      if (!item || docCheckCancelled) return
      const job: FactCheckJob = {
        id: newId(), kind: 'document', status: 'running',
        excerpt: item.claim, anchor: item.anchor, createdAt: Date.now(),
      }
      useStore.getState().addJob(job)
      try {
        const result = await checkPassage(item.claim)
        useStore.getState().updateJob(job.id, { status: 'done', result })
      } catch (e) {
        useStore.getState().updateJob(job.id, { status: 'error', error: String(e) })
      }
      done++
      useStore.getState().setDocCheckProgress({ done, total })
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker))
  useStore.getState().setDocCheckProgress(null)
}
