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
  /** The runs a thought with skipped words was saved as; `text` joins them with an ellipsis. */
  parts?: string[]
  /** Still to reach Readwise. Set only on highlights made on a Reader document with a token saved. */
  pending?: boolean
  /** Readwise's id for each run that landed, in order. */
  remoteIds?: string[]
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
  /** A voice check's verdict: true once read aloud, false if it never will be, unset while queued. */
  spoken?: boolean
  createdAt: number
}
