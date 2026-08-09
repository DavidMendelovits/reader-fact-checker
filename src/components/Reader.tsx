import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { checkSelection, highlightSelection, play } from '../lib/controller'
import { VERDICT_META } from './FactCheckPanel'

export function Reader() {
  const doc = useStore((s) => s.doc)
  const paragraphs = useStore((s) => s.paragraphs)
  const current = useStore((s) => s.currentParagraph)
  const playing = useStore((s) => s.playing)
  const highlights = useStore((s) => s.highlights)
  const jobs = useStore((s) => s.jobs)
  const containerRef = useRef<HTMLDivElement>(null)
  const [toolbar, setToolbar] = useState<{ x: number; y: number; text: string; anchor?: number } | null>(null)

  // auto-scroll the active paragraph into view while playing
  useEffect(() => {
    if (!playing) return
    containerRef.current
      ?.querySelector(`[data-flat="${current}"]`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [current, playing])

  useEffect(() => {
    function onSelection() {
      const sel = window.getSelection()
      const text = sel?.toString().trim()
      if (!sel || !text || text.length < 10 || !containerRef.current?.contains(sel.anchorNode)) {
        setToolbar(null)
        return
      }
      const rect = sel.getRangeAt(0).getBoundingClientRect()
      const anchorEl = (sel.anchorNode instanceof Element ? sel.anchorNode : sel.anchorNode?.parentElement)?.closest('[data-flat]')
      const anchor = anchorEl ? Number(anchorEl.getAttribute('data-flat')) : undefined
      setToolbar({ x: rect.left + rect.width / 2, y: rect.top - 8, text, anchor })
    }
    document.addEventListener('selectionchange', onSelection)
    return () => document.removeEventListener('selectionchange', onSelection)
  }, [])

  if (!doc) return null

  // group flat paragraphs back into chapters for headings
  const byAnchor = new Map(highlights.map((h) => [h.anchor, h] as const).reverse()) // store prepends, so reversing lets the newest highlight win the anchor
  // Jobs link to a highlight by id; anything saved before that field existed falls
  // back to matching the paragraph it was anchored to.
  const jobFor = (id: string, anchor: number) =>
    jobs.find((j) => j.highlightId === id) ?? jobs.find((j) => j.anchor === anchor && j.result)

  const runToolbar = (fn: (text: string, anchor?: number) => unknown) => (e: React.MouseEvent) => {
    e.preventDefault()
    if (!toolbar) return
    fn(toolbar.text, toolbar.anchor)
    setToolbar(null)
    window.getSelection()?.removeAllRanges()
  }

  let flat = 0
  return (
    <div className="reader" ref={containerRef}>
      {toolbar && (
        <div className="selection-toolbar" style={{ left: toolbar.x, top: toolbar.y }}>
          <button onMouseDown={runToolbar(checkSelection)}>✓ Fact check this</button>
          <button onMouseDown={runToolbar(highlightSelection)}>✦ Highlight</button>
        </div>
      )}
      <h1>{doc.title}</h1>
      {doc.chapters.map((ch, ci) => (
        <section key={ci}>
          {doc.chapters.length > 1 && <h2>{ch.title}</h2>}
          {ch.paragraphs.map((text, pi) => {
            const i = flat++
            const hl = byAnchor.get(i)
            const job = hl ? jobFor(hl.id, i) : undefined
            const verdict = job?.result && VERDICT_META[job.result.verdict]
            return (
              <p
                key={pi}
                data-flat={i}
                className={`${hl ? 'highlighted' : ''} ${i === current ? 'current' : ''}`.trim()}
                onDoubleClick={() => play(i)}
                title={hl ? undefined : 'Double-click to play from here'}
              >
                {text}
                {hl && (hl.note || job) && (
                  <span className="hl-tip">
                    {hl.note && <span className="hl-tip-note">{hl.note}</span>}
                    {verdict && (
                      <span className={`hl-tip-verdict ${verdict.className}`}>{verdict.label}</span>
                    )}
                    {job?.result && <span className="hl-tip-summary">{job.result.summary}</span>}
                    {job?.status === 'running' && <span className="hl-tip-summary">checking…</span>}
                  </span>
                )}
              </p>
            )
          })}
        </section>
      ))}
      <div style={{ height: '40vh' }} />
      {paragraphs.length === 0 && <p>Nothing readable found.</p>}
    </div>
  )
}
