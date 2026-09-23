// Trimmed port of the web app's types (src/types.ts) — same shapes, fewer of them —
// plus the library: what Reader knows about a document, and what this app keeps
// about it on the phone.
import type { Anchor } from './highlights'

export interface Chapter {
  title: string
  paragraphs: string[]
}

export interface Doc {
  id: string
  title: string
  source: string
  chapters: Chapter[]
}

export interface FlatParagraph {
  chapterIndex: number
  paragraphIndex: number
  text: string
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
}

export type Location = 'new' | 'later' | 'archive' | 'feed'

/** A document as the library sees it: Reader's metadata, in the app's terms. */
export interface LibraryDoc {
  id: string
  title: string
  author: string | null
  category: string | null
  location: Location
  sourceUrl: string | null
  wordCount: number | null
  summary: string | null
  tags: string[]
  /** 0..1 as Reader reports it; the phone keeps its own paragraph position too. */
  readingProgress: number | null
  publishedDate: string | null
  updatedAt: string
}

/** A highlight as Reader stores it: a child document of category "highlight". */
export interface RemoteHighlight {
  id: string
  docId: string
  text: string
  note: string | null
  updatedAt: string
}

/**
 * A highlight on this phone. `anchor` is where it was found in the text (null if
 * the passage couldn't be located, in which case it's listed but not painted).
 * `remoteId` is its id in Readwise once written back; `pending` is a write that
 * hasn't landed yet and will be retried.
 */
export interface Highlight {
  id: string
  remoteId?: string
  text: string
  note?: string
  anchor: Anchor | null
  createdAt: number
  pending?: 'create' | 'delete'
}

/** What /api/factcheck answers with once it has finished. */
export interface FactCheckResult {
  verdict: string
  summary: string
  spokenSummary: string
  sources: { title: string; url: string }[]
}

/**
 * A fact check the reader asked for, kept with the document it was asked about.
 * `anchorText` is the opening of the paragraph that was being read at the time,
 * so the check can be found again after the text has moved under it; `anchor` is
 * which paragraph that is now (null when it could not be found), and is what
 * tapping the row in the Checks tab jumps to.
 */
export interface Check {
  id: string
  claim: string
  verdict: string
  summary: string
  sources: { title: string; url: string }[]
  anchorText: string
  anchor: number | null
  createdAt: number
}

/** What the phone remembers about a document between sessions. */
export interface DocState {
  position: number
  highlights: Highlight[]
  /** Reader's own highlights already merged in, keyed by their id. */
  mergedRemote: string[]
  /** Optional: a state saved before checks existed still parses. */
  checks?: Check[]
  updatedAt: number
}

/** A Readwise Reader document, as /api/v3/list returns it. */
export interface ReaderDoc {
  id: string
  title: string | null
  author: string | null
  category: string | null
  location: string | null
  source_url: string | null
  word_count: number | null
  summary: string | null
  tags: Record<string, unknown> | string[] | null
  reading_progress: number | null
  published_date: string | number | null
  parent_id: string | null
  /** Highlights: the highlighted text. */
  content: string | null
  notes: string | null
  updated_at: string
  html_content?: string | null
}
