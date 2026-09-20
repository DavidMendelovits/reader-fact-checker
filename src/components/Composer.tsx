import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { play, pause, setMicEnabled, setMicMuted } from '../lib/controller'
import { say } from '../lib/agent'
import { voice } from '../lib/providers'
import { readLevels } from '../lib/audio-levels'
import { lineFor, MIC_LABEL, REPLY_HOLD_MS, type LineState } from '../../shared/voice/line.ts'

// The one bar at the bottom of the app: mic · line · play/pause · transcript · keyboard.
// It replaces the floating speaking pill, the chat panel's italic status line and the
// chat input — status is told once, here, by `lineFor`.

const MIC_TITLE: Record<LineState['micState'], string> = {
  notAsked: 'Turn the microphone on',
  live: 'Mute the microphone',
  muted: 'Unmute the microphone',
  denied: 'Mic is blocked. Allow it in the address bar',
  off: 'Turn the microphone on',
  restarting: 'The recognizer kept failing. Tap to try again',
}

/** What the screen reader is told when the state changes. Never the interim words. */
function announcement(micState: LineState['micState'], agentState: string, playing: boolean): string {
  if (agentState === 'listening') return 'Listening'
  if (agentState === 'thinking') return 'Thinking'
  if (playing) return 'Reading'
  if (micState === 'denied') return 'Microphone blocked'
  return 'Paused'
}

export function Composer({ onOpenTranscript }: { onOpenTranscript: () => void }) {
  const interim = useStore((s) => s.interim)
  const agentState = useStore((s) => s.agentState)
  const playing = useStore((s) => s.playing)
  const micEnabled = useStore((s) => s.micEnabled)
  const micMuted = useStore((s) => s.micMuted)
  const micDenied = useStore((s) => s.micDenied)
  const setMicDenied = useStore((s) => s.setMicDenied)
  const notice = useStore((s) => s.notice)
  const lastAgentLine = useStore((s) => s.lastAgentLine)
  const lastAgentLineAt = useStore((s) => s.lastAgentLineAt)
  const current = useStore((s) => s.currentParagraph)
  const total = useStore((s) => s.paragraphs.length)

  const [typing, setTyping] = useState(false)
  const [draft, setDraft] = useState('')
  const [, tick] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const micRef = useRef<HTMLButtonElement>(null)
  const asked = useRef(false)
  if (micEnabled) asked.current = true

  // The mic's own error path only sets a notice (controller.ts owns that call), so
  // this is where "the browser said no" turns into a state the button can show.
  useEffect(() => {
    if (notice && /microphone access denied/i.test(notice)) setMicDenied(true)
  }, [notice, setMicDenied])
  useEffect(() => {
    if (micEnabled && micDenied) setMicDenied(false)
  }, [micEnabled, micDenied, setMicDenied])

  const supported = voice.supported
  const micState: LineState['micState'] = !supported
    ? 'off'
    : micDenied
      ? 'denied'
      : !micEnabled
        ? asked.current
          ? 'off'
          : 'notAsked'
        : micMuted
          ? 'muted'
          : 'live'

  // The agent's reply holds the line for three seconds after it stops; nothing else
  // re-renders in that window, so the line needs its own nudge to let go of it.
  useEffect(() => {
    if (lastAgentLineAt === null) return
    const t = setTimeout(() => tick((n) => n + 1), REPLY_HOLD_MS + 100)
    return () => clearTimeout(t)
  }, [lastAgentLineAt])

  const line = lineFor({
    interim,
    agentState,
    playing,
    lastAgentLine,
    lastAgentLineAt,
    now: Date.now(),
    current,
    total,
    micState,
  })
  // `lineFor` speaks for both surfaces; on the web an absent recognizer is a browser
  // problem, not a settings one, so the idle hint says which browser to use.
  const idleHint = !interim && agentState === 'idle' && !playing && !lastAgentLine
  const text = !supported && idleHint ? 'Mic needs Chrome — tap ⌨ to type' : line.text

  // The ring around the mic breathes with what the mic hears. One rAF, one DOM
  // node, no React: this is 60 writes a second to a single custom property.
  useEffect(() => {
    const el = micRef.current
    if (!el || micState !== 'live') return
    const bars = new Float32Array(8)
    // Quantized to 1/32: the ring cannot show more than that, and an unchanged
    // level is a style write — and a style recalc — for nothing.
    let last = -1
    let frame = requestAnimationFrame(function loop() {
      frame = requestAnimationFrame(loop)
      const level = Math.round(Math.min(1, readLevels('mic', bars) * 1.6) * 32) / 32
      if (level === last) return
      last = level
      el.style.setProperty('--mic-level', String(level))
    })
    return () => {
      cancelAnimationFrame(frame)
      el.style.removeProperty('--mic-level')
    }
  }, [micState])

  const onMic = () => {
    if (!supported) return
    if (micState === 'live') setMicMuted(true)
    else if (micState === 'muted') setMicMuted(false)
    else setMicEnabled(true)
  }

  const send = () => {
    const t = draft.trim()
    if (!t) return
    say(t)
    setDraft('')
    setTyping(false)
  }

  return (
    <div className="composer">
      <div className="composer-row">
        <button
          ref={micRef}
          className="composer-btn mic"
          data-mic={micState}
          disabled={!supported}
          aria-label={supported ? MIC_LABEL[micState] : 'Microphone unavailable'}
          title={supported ? MIC_TITLE[micState] : 'Mic needs Chrome'}
          onClick={onMic}
        >
          {/* the slash for denied/unsupported is drawn in CSS, over the glyph */}
          <span aria-hidden="true">🎙</span>
        </button>

        {typing ? (
          <form
            className="composer-type"
            onSubmit={(e) => {
              e.preventDefault()
              send()
            }}
          >
            <input
              ref={inputRef}
              value={draft}
              autoFocus
              aria-label="Type a message"
              placeholder="Type instead of talking…"
              onChange={(e) => setDraft(e.target.value)}
            />
            {/* Collapses on send or on this ✕, never on blur — tapping the page
                mid-sentence should not throw the sentence away. */}
            <button type="button" className="composer-btn" aria-label="Close the text field" onClick={() => setTyping(false)}>
              <span aria-hidden="true">✕</span>
            </button>
          </form>
        ) : (
          <p className={`composer-line${line.italic ? ' interim' : ''}`}>{text}</p>
        )}

        <button
          className="composer-btn"
          aria-label={playing ? 'Pause' : 'Play'}
          title={playing ? 'Pause' : 'Play'}
          onClick={() => (playing ? pause() : play())}
        >
          <span aria-hidden="true">{playing ? '⏸' : '▶'}</span>
        </button>

        <button className="composer-btn transcript" aria-label="Transcript" onClick={onOpenTranscript}>
          Transcript
        </button>

        {!typing && (
          <button
            className="composer-btn"
            aria-label="Type a message"
            title="Type a message"
            onClick={() => setTyping(true)}
          >
            <span aria-hidden="true">⌨</span>
          </button>
        )}
      </div>

      <div className="sr-only" role="status" aria-live="polite">
        {announcement(micState, agentState, playing)}
      </div>
    </div>
  )
}
