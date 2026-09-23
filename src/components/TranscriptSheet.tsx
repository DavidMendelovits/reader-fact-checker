import { useEffect, useRef, useState } from 'react'
import { ChatPanel } from './ChatPanel'
import { FactCheckPanel } from './FactCheckPanel'
import { Glyph } from './Glyph'

// Under 900px the sidebar has nowhere to go, so it becomes this: a bottom sheet
// the Composer's Transcript button opens, with the conversation and the checks as
// two tabs. At 900px and up the sidebar is still there and this never opens.

export function TranscriptSheet({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<'chat' | 'checks'>('chat')
  const [dy, setDy] = useState(0)
  const sheetRef = useRef<HTMLDivElement>(null)
  const dragFrom = useRef<number | null>(null)

  // Focus moves in on open and goes back where it came from on close — which is
  // the Transcript button, since that is the only thing that opens this.
  useEffect(() => {
    const returnTo = document.activeElement as HTMLElement | null
    sheetRef.current?.focus()
    return () => returnTo?.focus?.()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
        return
      }
      if (e.key !== 'Tab') return
      const focusable = sheetRef.current?.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      )
      if (!focusable?.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const active = document.activeElement
      if (e.shiftKey && (active === first || active === sheetRef.current)) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const onPointerDown = (e: React.PointerEvent) => {
    dragFrom.current = e.clientY
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (dragFrom.current === null) return
    setDy(Math.max(0, e.clientY - dragFrom.current))
  }
  const onPointerUp = () => {
    if (dragFrom.current === null) return
    dragFrom.current = null
    if (dy > 80) onClose()
    setDy(0)
  }

  return (
    <div className="sheet-scrim" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Transcript"
        tabIndex={-1}
        ref={sheetRef}
        style={dy ? { transform: `translateY(${dy}px)` } : undefined}
      >
        <div
          className="sheet-grab"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <span aria-hidden="true" />
        </div>
        <div className="sheet-tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'chat'} className={tab === 'chat' ? 'on' : ''} onClick={() => setTab('chat')}>
            Conversation
          </button>
          <button role="tab" aria-selected={tab === 'checks'} className={tab === 'checks' ? 'on' : ''} onClick={() => setTab('checks')}>
            Checks
          </button>
          <button className="sheet-close" aria-label="Close the transcript" onClick={onClose}>
            <Glyph name="close" size={16} />
          </button>
        </div>
        <div className="sheet-body">{tab === 'chat' ? <ChatPanel /> : <FactCheckPanel />}</div>
      </div>
    </div>
  )
}
