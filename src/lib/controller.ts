// Wires voice ⇄ TTS ⇄ agent ⇄ store. Plain module, no React.
//
// Live interaction runs through the agent conversation (lib/agent.ts). The manual
// transport controls and the whole-document scan stay direct: a play button should
// not need a model round-trip, and a batch scan is a job, not a conversation.
import { useStore } from '../store'
import { tts } from './tts'
import { voice } from './voice'
import { beginUtterance, openingTurn, say, sayInterim } from './agent'
import { startMicMeter, stopMicMeter } from './audio-levels'
import { checkPassage, completeField, extractClaims } from './factcheck'
import { mapLimit } from './maplimit'
import type { FactCheckJob, Highlight } from '../types'

let jobCounter = 0
const newId = () => `job-${Date.now()}-${++jobCounter}`

// ---- manual playback ----

export function play(fromIndex?: number) {
  const s = useStore.getState()
  const start = fromIndex ?? s.currentParagraph
  tts.setParagraphs(s.paragraphs.map((p) => p.text))
  tts.setRate(s.rate)
  void tts.playFrom(start).then((outcome) => {
    if (outcome === 'failed')
      useStore.setState({ notice: 'Narration failed — the speech service is unreachable. Your position is saved.' })
  })
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
// The agent's replies used to mute the mic outright, plus a 1200ms tail to cover the
// late final. Both are gone: the mute made barging in over a reply impossible, and
// the tail ate the first words of anyone who answered the moment it stopped. The
// reply text stays echo-matchable for ECHO_MEMORY after it finishes playing, which
// covers the late final without dropping anything real.

// ---- voice input ----
//
// No wake word: the mic stays live during narration so you can simply talk over it.
// voice.isEcho() drops the recognizer's transcription of the narration itself.
voice.onUtterance = (text) => say(text)
// "pause" is one word and Chrome sits on it until you've been quiet for a beat, so
// transport commands are run off the partial transcript instead.
voice.onInterim = (text) => sayInterim(text)
voice.onSpeechStart = () => beginUtterance()
voice.getSpokenText = () => tts.speaking
voice.getRecentSpokenText = () => tts.recentlySpoken
voice.onError = (msg) => {
  useStore.setState({ micEnabled: false, notice: msg })
}

export function setMicEnabled(enabled: boolean) {
  useStore.setState({ micEnabled: enabled, micMuted: false })
  voice.setUserMuted(false)
  if (enabled) {
    void voice.start() // async now: it waits on the shared echo-cancelled capture
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

  // Say the verdict the moment that field closes, rather than after the sources and
  // the rest of the object. Never over the narration — that's an interruption the
  // user didn't ask for.
  let spoken = false
  const speak = (line: string) => {
    if (spoken || !line || useStore.getState().playing) return
    spoken = true
    void tts.speak(line)
  }
  void checkPassage(passage, (raw) => {
    useStore.getState().updateJob(job.id, { partial: raw })
    speak(completeField(raw, 'spokenSummary'))
  })
    .then((result) => {
      useStore.getState().updateJob(job.id, { status: 'done', result })
      speak(result.spokenSummary) // a cached verdict arrives with no stream to speak from
    })
    .catch((e) => useStore.getState().updateJob(job.id, { status: 'error', error: String(e) }))
}

// ---- whole-document flow ----

let docCheckCancelled = false
const CONCURRENCY = 3
const scanning = <T, R>(items: T[], task: (item: T) => Promise<R>) =>
  mapLimit(items, CONCURRENCY, task, () => docCheckCancelled)

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

  // Sections are independent, so extracting their claims one at a time just stacked
  // model round-trips in front of the first check that actually matters.
  let extracted = 0
  const claims = (
    await scanning(sections, async (section) => {
      try {
        return (await extractClaims(section.text)).map((claim) => ({ claim, anchor: section.anchor }))
      } catch (e) {
        console.error('claim extraction failed for a section', e)
        return [] // a bad section shouldn't abort a whole-document scan
      } finally {
        useStore.getState().setDocCheckProgress({ done: ++extracted, total: sections.length })
      }
    })
  ).flat()
  if (docCheckCancelled) return

  const total = sections.length + claims.length
  let done = sections.length
  await scanning(claims, async (item) => {
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
    useStore.getState().setDocCheckProgress({ done: ++done, total })
  })
  useStore.getState().setDocCheckProgress(null)
}
