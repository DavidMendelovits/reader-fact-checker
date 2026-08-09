export interface Chapter {
  title: string
  paragraphs: string[]
}

export interface Doc {
  /** Stable across imports of the same source — the library key. */
  id: string
  title: string
  /** Article URL, or the EPUB filename. Shown in the library list. */
  source: string
  chapters: Chapter[]
}

// Global paragraph position: flat index across all chapters
export interface FlatParagraph {
  chapterIndex: number
  paragraphIndex: number
  text: string
}

export type Verdict = 'accurate' | 'inaccurate' | 'misleading' | 'unverifiable'

export interface FactCheckResult {
  verdict: Verdict
  summary: string
  spokenSummary: string
  sources: { title: string; url: string }[]
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
}

export interface Highlight {
  id: string
  anchor: number // flat paragraph index the passage came from
  text: string
  note?: string
  createdAt: number
}

export interface FactCheckJob {
  id: string
  kind: 'voice' | 'highlight' | 'document'
  status: 'running' | 'done' | 'error'
  excerpt: string
  question?: string
  result?: FactCheckResult
  error?: string
  anchor?: number // flat paragraph index to scroll to
  /** The highlight this check was born from, when there is one. */
  highlightId?: string
  /** Raw model text as it streams in, so a running card fills in rather than sitting empty. */
  partial?: string
  createdAt: number
}
