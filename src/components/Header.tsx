import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { pause, checkWholeDocument, cancelDocumentCheck } from '../lib/controller'
import { tts } from '../lib/providers'
import { Glyph } from './Glyph'

// Four things, in one row that never wraps at 375px: back, title, speed, check.
// Mic and Play moved to the Composer; position moved into its line.

const RATES = [0.8, 1, 1.2, 1.5, 2]

/** `1×`, `1.2×`, `1.75×` — no trailing zero, because the pill is 44px wide. */
const label = (r: number) => `${Number(r.toFixed(2))}×`

function SpeedPill() {
  const rate = useStore((s) => s.rate)
  const setRate = useStore((s) => s.setRate)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // The agent can set any rate in [0.5, 3] ("one point seven five times"), so its
  // value joins the list rather than the pill showing a speed you cannot pick again.
  const rates = RATES.includes(rate) ? RATES : [...RATES, rate].sort((a, b) => a - b)

  return (
    <div className="speed" ref={ref}>
      <button
        className="speed-pill"
        aria-label={`Speed, ${label(rate)}`}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {label(rate)}
      </button>
      {open && (
        <div className="speed-menu" role="menu">
          {rates.map((r) => (
            <button
              key={r}
              role="menuitemradio"
              aria-checked={r === rate}
              className={r === rate ? 'on' : ''}
              onClick={() => {
                setRate(r)
                tts.setRate(r)
                setOpen(false)
              }}
            >
              {label(r)}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function Header() {
  const title = useStore((s) => s.doc?.title)
  const clearDoc = useStore((s) => s.clearDoc)
  const progress = useStore((s) => s.docCheckProgress)
  if (title === undefined) return null

  return (
    <header className="header">
      <button
        className="header-back"
        onClick={() => {
          pause()
          clearDoc()
        }}
      >
        ← Library
      </button>

      <h1 className="header-title" title={title}>{title}</h1>

      <SpeedPill />

      {progress ? (
        <button className="header-check running" onClick={cancelDocumentCheck} aria-label="Cancel the document check">
          <span className="check-label">
            Checking {progress.done}/{progress.total}
          </span>
          <Glyph name="close" size={16} />
          <span
            className="check-bar"
            style={{ transform: `scaleX(${progress.total ? progress.done / progress.total : 0})` }}
          />
        </button>
      ) : (
        <button className="header-check" onClick={() => void checkWholeDocument()}>
          {/* "document" drops out under 560px so nothing in this row ever wraps */}
          Check<span className="wide"> document</span>
        </button>
      )}
    </header>
  )
}
