import { Analytics } from '@vercel/analytics/react'
import { useStore } from './store'
import { ImportScreen } from './components/ImportScreen'
import { Reader } from './components/Reader'
import { PlayerBar } from './components/PlayerBar'
import { FactCheckPanel } from './components/FactCheckPanel'
import { ChatPanel } from './components/ChatPanel'
import { SpeakingIndicator } from './components/SpeakingIndicator'
import { Notice } from './components/Notice'

export default function App() {
  const doc = useStore((s) => s.doc)
  return (
    <>
      {doc ? (
        <div className="app">
          <PlayerBar />
          <div className="main">
            <Reader />
            <aside className="sidebar">
              <ChatPanel />
              <FactCheckPanel />
            </aside>
          </div>
          <SpeakingIndicator />
        </div>
      ) : (
        <ImportScreen />
      )}
      <Notice />
      {/* ponytail: no-ops off Vercel, so no env gate */}
      <Analytics />
    </>
  )
}
