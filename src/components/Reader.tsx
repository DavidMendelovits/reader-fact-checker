import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import { checkSelection, highlightSelection, play } from '../lib/controller'
import { VERDICT_META } from './FactCheckPanel'
import type { FactCheckJob, Highlight } from '../types'
import { Glyph } from './Glyph'

/**
 * One paragraph. Memo'd on exactly what it draws: a streaming fact check writes to
 * its job many times a second, and nothing but the paragraph that job belongs to
 * should commit. A paragraph with no highlight is handed `undefined` for both and
 * therefore never re-renders for a job at all.
 */
const Paragraph = memo(function Paragraph({
  text,
  index,
  current,
  highlight,
  job,
}: {
  text: string
  index: number
  current: boolean
  highlight?: Highlight
  job?: FactCheckJob
}) {
  const verdict = job?.result && VERDICT_META[job.result.verdict]
  return (
    <p
      data-flat={index}
      className={`${highlight ? 'highlighted' : ''} ${current ? 'current' : ''}`.trim()}
      onDoubleClick={() => play(index)}
    >
      {text}
      {highlight && (highlight.note || job) && (
        <span className="hl-tip">
          {highlight.note && <span className="hl-tip-note">{highlight.note}</span>}
          {verdict && <span className={`hl-tip-verdict ${verdict.className}`}>{verdict.label}</span>}
          {job?.result && <span className="hl-tip-summary">{job.result.summary}</span>}
          {job?.status === 'running' && <span className="hl-tip-summary">checking…</span>}
        </span>
      )}
    </p>
  )
})

export function Reader() {
  const doc = useStore((s) => s.doc)
  const paragraphs = useStore((s) => s.paragraphs)
  const current = useStore((s) => s.currentParagraph)
  const playing = useStore((s) => s.playing)
  const highlights = useStore((s) => s.highlights)
  const jobs = useStore((s) => s.jobs)
  const containerRef = useRef<HTMLDivElement>(null)
  const [toolbar, setToolbar] = useState<{ x: number; y: number; text: string; anchor?: number } | null>(null)
  const [offscreen, setOffscreen] = useState(false)
  // Follow-the-voice is off while the reader is reading ahead by hand, until the
  // playhead comes back into view or the pill is tapped.
  const userScrolled = useRef(false)
  /** The playhead has been off screen since the reader took the scroll. */
  const leftView = useRef(false)

  // A reopened book opens at its saved position, not at the top — jump there
  // instantly on render, before narration starts, so playback never begins with
  // a scroll from the title down to the middle of the book.
  useEffect(() => {
    const at = useStore.getState().currentParagraph
    if (at === 0) return
    containerRef.current
      ?.querySelector(`[data-flat="${at}"]`)
      ?.scrollIntoView({ behavior: 'auto', block: 'center' })
  }, [doc])

  // auto-scroll the active paragraph into view while playing
  useEffect(() => {
    if (!playing || userScrolled.current) return
    containerRef.current
      ?.querySelector(`[data-flat="${current}"]`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [current, playing])

  // Any scroll the user starts themselves suspends the follow.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const stop = () => {
      userScrolled.current = true
    }
    // a scrollbar drag is neither a wheel nor a touch, and fires nothing of its own
    const onPointerDown = (e: PointerEvent) => {
      if (e.clientX > el.getBoundingClientRect().left + el.clientWidth) stop()
    }
    el.addEventListener('wheel', stop, { passive: true })
    el.addEventListener('touchmove', stop, { passive: true })
    el.addEventListener('pointerdown', onPointerDown)
    return () => {
      el.removeEventListener('wheel', stop)
      el.removeEventListener('touchmove', stop)
      el.removeEventListener('pointerdown', onPointerDown)
    }
  }, [])

  // Is the playhead on screen? Answers both the pill and "the user scrolled it
  // back themselves, so start following again".
  useEffect(() => {
    const el = containerRef.current?.querySelector(`[data-flat="${current}"]`)
    if (!el) return
    const io = new IntersectionObserver(
      ([entry]) => {
        setOffscreen(!entry.isIntersecting)
        if (!entry.isIntersecting) {
          leftView.current = true
          return
        }
        // The observer calls back once as soon as it is attached, and it is
        // attached again on every paragraph — so "it is on screen" was clearing
        // the suspension a paragraph after every scroll. Only a playhead that
        // actually left and came back is the reader catching up with it.
        if (!leftView.current) return
        leftView.current = false
        userScrolled.current = false
      },
      { root: containerRef.current, threshold: 0.1 },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [current, doc])

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

  // Built once per change instead of once per paragraph: the old form was
  // O(paragraphs × jobs) on every keystroke of a streaming verdict.
  const highlightByAnchor = useMemo(
    // the store prepends, so reversing lets the newest highlight win the anchor
    () => new Map(highlights.map((h) => [h.anchor, h] as const).reverse()),
    [highlights],
  )
  const jobIndex = useMemo(() => {
    const byHighlight = new Map<string, FactCheckJob>()
    // Jobs link to a highlight by id; anything saved before that field existed
    // falls back to matching the paragraph it was anchored to.
    const byAnchor = new Map<number, FactCheckJob>()
    for (const j of jobs) {
      if (j.highlightId && !byHighlight.has(j.highlightId)) byHighlight.set(j.highlightId, j)
      if (j.anchor != null && j.result && !byAnchor.has(j.anchor)) byAnchor.set(j.anchor, j)
    }
    return { byHighlight, byAnchor }
  }, [jobs])

  if (!doc) return null

  const runToolbar = (fn: (text: string, anchor?: number) => unknown) => (e: React.PointerEvent) => {
    e.preventDefault()
    if (!toolbar) return
    fn(toolbar.text, toolbar.anchor)
    setToolbar(null)
    window.getSelection()?.removeAllRanges()
  }

  const backToVoice = () => {
    userScrolled.current = false
    leftView.current = false
    containerRef.current
      ?.querySelector(`[data-flat="${current}"]`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  let flat = 0
  return (
    <div className="reader" ref={containerRef}>
      {toolbar && (
        <div className="selection-toolbar" style={{ left: toolbar.x, top: toolbar.y }}>
          <button onPointerDown={runToolbar(checkSelection)}>Fact check this</button>
          <button onPointerDown={runToolbar(highlightSelection)}>Highlight</button>
          <button onPointerDown={runToolbar((_text, anchor) => play(anchor))}>
            <Glyph name="play" size={14} /> Play from here
          </button>
        </div>
      )}
      {offscreen && playing && (
        <button className="back-to-voice" onClick={backToVoice}>
          ↓ Back to the voice
        </button>
      )}
      <h1>{doc.title}</h1>
      {doc.chapters.map((ch, ci) => (
        <section key={ci}>
          {doc.chapters.length > 1 && <h2>{ch.title}</h2>}
          {ch.paragraphs.map((text, pi) => {
            const i = flat++
            const hl = highlightByAnchor.get(i)
            return (
              <Paragraph
                key={pi}
                text={text}
                index={i}
                current={i === current}
                highlight={hl}
                job={hl ? jobIndex.byHighlight.get(hl.id) ?? jobIndex.byAnchor.get(i) : undefined}
              />
            )
          })}
        </section>
      ))}
      <div style={{ height: '40vh' }} />
      {paragraphs.length === 0 && <p>Nothing readable found.</p>}
    </div>
  )
}
