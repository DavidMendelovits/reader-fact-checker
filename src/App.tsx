import { useState } from 'react'
import { Analytics } from '@vercel/analytics/react'
import { useStore } from './store'
import { ImportScreen } from './components/ImportScreen'
import { Reader } from './components/Reader'
import { Header } from './components/Header'
import { FactCheckPanel } from './components/FactCheckPanel'
import { ChatPanel } from './components/ChatPanel'
import { Composer } from './components/Composer'
import { TranscriptSheet } from './components/TranscriptSheet'
import { Aurora } from './components/Aurora'
import { Notice } from './components/Notice'

export default function App() {
  const doc = useStore((s) => s.doc)
  const [sheet, setSheet] = useState(false)

  return (
    <>
      {/* behind everything, at the window's edges; the app's surfaces are opaque */}
      <Aurora />
      {doc ? (
        // header / scroll region / Composer, at 100dvh so the soft keyboard pushes
        // the Composer up instead of hiding it
        <div className="app">
          <Header />
          <div className="main">
            <Reader />
            <aside className="sidebar">
              <ChatPanel />
              <FactCheckPanel />
            </aside>
          </div>
          <Composer onOpenTranscript={() => setSheet(true)} />
          {sheet && <TranscriptSheet onClose={() => setSheet(false)} />}
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
