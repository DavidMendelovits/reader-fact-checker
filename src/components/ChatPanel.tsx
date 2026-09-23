import { useEffect, useRef } from 'react'
import { useStore } from '../store'
import { COPY } from '../../shared/voice/line.ts'

// History only. What the app is doing right now is the Composer's line — this used
// to say it too, in its own words, and the two could disagree.

export function ChatPanel() {
  const chat = useStore((s) => s.chat)
  const endRef = useRef<HTMLDivElement>(null)

  // Only a new line scrolls. Following `agentState` meant the log jumped every time
  // the agent blinked.
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [chat.length])

  return (
    <section className="chat-panel">
      <h3>Conversation</h3>
      <div className="chat-log">
        {chat.length === 0 && (
          <p className="hint">{COPY.emptyTranscript}</p>
        )}
        {chat.map((m) => (
          <div key={m.id} className={`chat-msg ${m.role}`}>
            {m.text}
          </div>
        ))}
        <div ref={endRef} />
      </div>
    </section>
  )
}
