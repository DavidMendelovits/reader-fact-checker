import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { say } from '../lib/agent'

const STATUS: Record<string, string> = {
  listening: 'listening…',
  thinking: 'thinking…',
  speaking: 'speaking…',
  // agentState says 'reading' from the moment the tool starts, which is before any
  // audio exists — `playing` is what actually tracks sound coming out
  reading: 'starting the audio…',
}
const READING = 'reading — talk any time to interrupt'
const READING_MUTED = 'reading — mic muted, type to interrupt'

export function ChatPanel() {
  const chat = useStore((s) => s.chat)
  const agentState = useStore((s) => s.agentState)
  const micMuted = useStore((s) => s.micMuted)
  const playing = useStore((s) => s.playing)
  const [draft, setDraft] = useState('')
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [chat.length, agentState, playing])

  // Playing beats everything: it's the only signal that survives a manual Play, a
  // failed synthesis, or a loop that ended while the audio kept going.
  const status = playing ? (micMuted ? READING_MUTED : READING) : STATUS[agentState]

  return (
    <section className="chat-panel">
      <h3>Conversation</h3>
      <div className="chat-log">
        {chat.length === 0 && (
          <p className="hint">
            Ask it to start reading, then just talk over it — “wait, is that true?”, “what does that
            mean?”, “skip to chapter three”.
          </p>
        )}
        {chat.map((m) => (
          <div key={m.id} className={`chat-msg ${m.role}`}>
            {m.text}
          </div>
        ))}
        {status && <div className="chat-status">{status}</div>}
        <div ref={endRef} />
      </div>
      <form
        className="chat-input"
        onSubmit={(e) => {
          e.preventDefault()
          say(draft)
          setDraft('')
        }}
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Type instead of talking…"
        />
        <button type="submit">Send</button>
      </form>
    </section>
  )
}
