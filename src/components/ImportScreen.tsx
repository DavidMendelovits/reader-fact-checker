import { useState } from 'react'
import { extractFromUrl, extractFromEpub } from '../lib/extract'
import { useStore } from '../store'
import { tts } from '../lib/providers'
import { loadLibrary, openEntry, forgetEntry } from '../lib/persist'
import type { LibraryEntry } from '../lib/persist'
import { Glyph } from './Glyph'

// ---- cross-book search ----
//
// The library is at most a handful of entries, so this is a plain substring scan on
// every keystroke rather than an index — what's worth finding is what you said about
// a book, not just its title.

interface Match {
  source: 'conversation' | 'highlight'
  snippet: string
}

const SNIPPET = 100

/** ~100 chars centred on the hit, so the matched words are actually on screen. */
function snippetAround(text: string, at: number, len: number): string {
  const start = Math.max(0, at - Math.round((SNIPPET - len) / 2))
  const end = start + SNIPPET
  return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`
}

function searchEntry(entry: LibraryEntry, q: string): Match[] {
  const matches: Match[] = []
  const scan = (source: Match['source'], text?: string) => {
    if (!text || matches.length >= 2) return
    const at = text.toLowerCase().indexOf(q)
    if (at >= 0) matches.push({ source, snippet: snippetAround(text, at, q.length) })
  }
  for (const m of entry.chat ?? []) scan('conversation', m.text)
  for (const h of entry.highlights ?? []) {
    scan('highlight', h.text)
    scan('highlight', h.note)
  }
  return matches
}

export function ImportScreen() {
  const setDoc = useStore((s) => s.setDoc)
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [library, setLibrary] = useState(loadLibrary)
  const [query, setQuery] = useState('')
  const [dragging, setDragging] = useState(false)

  async function load(fn: () => Promise<Parameters<typeof setDoc>[0]>) {
    setBusy(true)
    setError(null)
    try {
      const doc = await fn()
      tts.clearCacheForNewDoc()
      setDoc(doc)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="import-screen">
      <h1>readwithme</h1>
      <p className="tagline">
        Listen to any article or book, and talk to it — interrupt any time to ask what’s true.
      </p>

      {/* One card: paste a URL, or drop a file. Two ways in, one place to look. */}
      <div
        className={`import-card${dragging ? ' dragging' : ''}`}
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          const file = e.dataTransfer.files[0]
          if (file) void load(() => extractFromEpub(file))
        }}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (url.trim()) void load(() => extractFromUrl(url.trim()))
          }}
        >
          <input
            type="url"
            placeholder="Paste an article URL"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            disabled={busy}
          />
          <button type="submit" disabled={busy || !url.trim()}>
            {busy && <span className="dots" aria-hidden="true" />}
            {busy ? 'Loading…' : 'Read article'}
          </button>
        </form>

        <label className="drop-row">
          <span>or drop an EPUB here</span>
          <input
            type="file"
            accept=".epub"
            disabled={busy}
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) void load(() => extractFromEpub(file))
            }}
          />
        </label>
      </div>

      {error && <p className="error">{error}</p>}

      {library.length > 0 && (() => {
        const q = query.trim().toLowerCase()
        const results = library
          .map((entry) => ({ entry, matches: q ? searchEntry(entry, q) : [] }))
          .filter(({ entry, matches }) => !q || matches.length > 0 || entry.title.toLowerCase().includes(q))
        return (
          <div className="library">
            <h2>Continue reading</h2>
            <input
              className="library-search"
              type="search"
              placeholder="Search your books and conversations…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {q && results.length === 0 && <p className="library-empty">Nothing matches “{query.trim()}”.</p>}
            <ul>
              {results.map(({ entry, matches }) => {
                const total = entry.doc.chapters.reduce((n, c) => n + c.paragraphs.length, 0)
                const checks = entry.jobs?.length ?? 0
                return (
                  <li key={entry.id}>
                    <button className="library-open" onClick={() => openEntry(entry)}>
                      <span className="library-title">{entry.title}</span>
                      <span className="library-meta">
                        {entry.source} · ¶{(entry.currentParagraph ?? 0) + 1} of {total}
                        {checks > 0 && ` · ${checks} fact check${checks === 1 ? '' : 's'}`}
                      </span>
                      {matches.map((m, i) => (
                        <span className="library-hit" key={i}>
                          <span className="library-hit-source">
                            {m.source === 'highlight' ? 'highlight' : 'conversation'}
                          </span>
                          {m.snippet}
                        </span>
                      ))}
                    </button>
                    <button
                      className="library-forget"
                      aria-label={`Remove ${entry.title} from the library`}
                      title="Remove from library"
                      onClick={() => {
                        forgetEntry(entry.id)
                        setLibrary(loadLibrary())
                      }}
                    >
                      <Glyph name="close" size={16} />
                    </button>
                  </li>
                )
              })}
            </ul>
          </div>
        )
      })()}
    </div>
  )
}
