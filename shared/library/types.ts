// The reading library's shapes, shared by the phone, the web app and the
// server: what Reader knows about a document, in the app's terms, and the port
// every library adapter implements. No imports, so it runs anywhere.

export interface Chapter {
  title: string
  paragraphs: string[]
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
  /** 0..1 as Reader reports it; each app keeps its own paragraph position too. */
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

export interface Page<T> {
  items: T[]
  nextCursor: string | null
}

/**
 * The reading library: where documents and highlights live and sync to. Today
 * that is Readwise Reader (readwise.ts). The apps never see a Reader URL or a
 * Reader field name outside that adapter.
 */
export interface Library {
  /** One page of documents in a location, newest first. `updatedAfter` narrows to changes. */
  listDocuments(opts: { location: Location; updatedAfter?: string; cursor?: string }): Promise<Page<LibraryDoc>>
  /** A document's full HTML, for reading. Null when the library has no text for it (a PDF, say). */
  fetchHtml(id: string): Promise<{ doc: LibraryDoc; html: string | null }>
  /** File a document: inbox, later, archive. */
  move(id: string, location: Location): Promise<void>
  /** One page of highlights across the library. `updatedAfter` narrows to changes. */
  listHighlights(opts: { updatedAfter?: string; cursor?: string }): Promise<Page<RemoteHighlight>>
  /** Record a highlight on a document. Resolves with its id in the library. */
  createHighlight(input: { doc: LibraryDoc; text: string; note?: string }): Promise<{ remoteId: string }>
  deleteHighlight(remoteId: string): Promise<void>
}
