// Trimmed port of the web app's types (src/types.ts) — same shapes, fewer of them.

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

export interface Highlight {
  id: string
  anchor: number
  text: string
  note?: string
  createdAt: number
}

/** A Readwise Reader document, as /api/v3/list returns it. */
export interface ReaderDoc {
  id: string
  title: string | null
  author: string | null
  category: string | null
  source_url: string | null
  word_count: number | null
  updated_at: string
  html_content?: string | null
}
