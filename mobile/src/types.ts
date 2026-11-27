// Trimmed port of the web app's types (src/types.ts) — same shapes, fewer of them —
// plus the library: what Reader knows about a document, and what this app keeps
// about it on the phone.
import type { Anchor } from './highlights'

import type { Chapter } from '../../shared/library/types'
export type { Chapter, LibraryDoc, Location, ReaderDoc, RemoteHighlight } from '../../shared/library/types'

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
  /** Its place in a Readwise-concatenated highlight (skipped words); sent as the .cN tag, never shown. */
  concat?: number
  /** Shared by the runs of one concatenated highlight, so they are listed and removed together. */
  group?: string
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

