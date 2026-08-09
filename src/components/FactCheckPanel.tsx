import { useStore } from '../store'
import { completeField, partialField } from '../lib/factcheck'
import type { FactCheckJob, Verdict } from '../types'

const scrollTo = (anchor?: number) => {
  if (anchor != null)
    document.querySelector(`[data-flat="${anchor}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
}

export const VERDICT_META: Record<Verdict, { label: string; className: string }> = {
  accurate: { label: '✓ Accurate', className: 'v-accurate' },
  inaccurate: { label: '✗ Inaccurate', className: 'v-inaccurate' },
  misleading: { label: '⚠ Misleading', className: 'v-misleading' },
  unverifiable: { label: '? Unverifiable', className: 'v-unverifiable' },
}

const KIND_LABEL = { voice: '🎙 voice', highlight: '✎ highlight', document: '📄 doc scan' }

function JobCard({ job }: { job: FactCheckJob }) {
  // the verdict field closes well before the object does — show it the moment it lands
  const early = job.status === 'running' ? (completeField(job.partial ?? '', 'verdict') as Verdict) : null
  return (
    <div className={`job-card ${job.status}`}>
      <div className="job-head">
        <span className="kind">{KIND_LABEL[job.kind]}</span>
        {job.status === 'running' &&
          (early && VERDICT_META[early] ? (
            <span className={VERDICT_META[early].className}>{VERDICT_META[early].label}</span>
          ) : (
            <span className="spinner">searching…</span>
          ))}
        {job.status === 'error' && <span className="v-inaccurate">error</span>}
        {job.result && (
          <span className={VERDICT_META[job.result.verdict]?.className ?? ''}>
            {VERDICT_META[job.result.verdict]?.label ?? job.result.verdict}
          </span>
        )}
      </div>
      <blockquote onClick={() => scrollTo(job.anchor)}>
        {job.question ?? job.excerpt}
      </blockquote>
      {job.status === 'running' && job.partial && (
        <p className="summary streaming">{partialField(job.partial, 'summary')}</p>
      )}
      {job.result && (
        <>
          <p className="summary">{job.result.summary}</p>
          {job.result.sources.length > 0 && (
            <ul className="sources">
              {job.result.sources.map((src) => (
                <li key={src.url}>
                  <a href={src.url} target="_blank" rel="noreferrer">{src.title}</a>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {job.error && <p className="error">{job.error}</p>}
    </div>
  )
}

export function FactCheckPanel() {
  const jobs = useStore((s) => s.jobs)
  const highlights = useStore((s) => s.highlights)
  const removeHighlight = useStore((s) => s.removeHighlight)
  const doc = useStore((s) => s.doc)
  if (!doc) return null

  return (
    <section className="factcheck-panel">
      {highlights.length > 0 && (
        <>
          <h3>Highlights</h3>
          {highlights.map((h) => (
            <div key={h.id} className="job-card">
              <div className="job-head">
                <span className="kind">✦ ¶ {h.anchor + 1}</span>
                <button className="card-remove" title="Remove highlight" onClick={() => removeHighlight(h.id)}>
                  ✕
                </button>
              </div>
              <blockquote onClick={() => scrollTo(h.anchor)}>{h.text}</blockquote>
              {h.note && <p className="highlight-note">{h.note}</p>}
            </div>
          ))}
        </>
      )}

      <h3>Fact checks</h3>
      {jobs.length === 0 && (
        <p className="hint">Verdicts land here — from the conversation, a highlight, or a full scan.</p>
      )}
      {jobs.map((job) => <JobCard key={job.id} job={job} />)}
    </section>
  )
}
