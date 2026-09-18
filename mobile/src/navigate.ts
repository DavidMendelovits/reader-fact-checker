// Fast navigation: what the reader means, decided in one short round trip
// instead of a conversation turn. "Open the Hemingway one", "skip to chapter
// three", "archive that", "hold on", "back to the library" have one right
// answer among a short list; the server's decision model (/api/navigate)
// names it with a confidence, and the app acts on a confident answer at once.
// Anything unsure goes to the conversation exactly as before, so the worst case
// is what it was: a model turn.
//
// It is asked on partial transcripts too, while the reader is still speaking —
// that is where the time goes: the recognizer waits for silence before it
// finalizes, and the words are usually clear well before then. A partial holds
// a higher bar.
import { apiBase } from './settings'
import { library } from './session'
import { useStore } from './store'
import type { LibraryDoc, Location } from './types'

export type NavAction =
  | { kind: 'open'; id: string }
  | { kind: 'list' }
  | { kind: 'chapter'; index: number }
  | { kind: 'next_chapter' }
  | { kind: 'previous_chapter' }
  | { kind: 'beginning' }
  | { kind: 'close' }
  | { kind: 'file'; shelf: Location }
  | { kind: 'pause' }
  | { kind: 'resume' }

export interface Decision {
  intent: string
  confidence: number
  doc?: { id: string; confidence: number }
  chapter?: { index: number; confidence: number }
  shelf?: { id: string; confidence: number }
}

/** How sure the model has to be before the app acts without asking the conversation. */
export const FINAL_BAR = 0.6
export const PARTIAL_BAR = 0.8
/** And how sure about which document, chapter, or shelf. */
export const TARGET_BAR = 0.5
/** A decision slower than this is slower than the model turn it was meant to spare. */
const TIMEOUT_MS = 2500
/** The server said no decider is configured; ask again after a while, not on every utterance. */
const DISABLED_FOR_MS = 5 * 60 * 1000
const MAX_DOCS = 120

const SHELVES: { id: Location; label: string }[] = [
  { id: 'new', label: 'Inbox' },
  { id: 'later', label: 'Later' },
  { id: 'archive', label: 'Archive' },
]

let disabledUntil = 0

/** Documents the reader might mean: search matches first, then the newest on each shelf. */
export function candidates(text: string): { id: string; title: string; author: string | null }[] {
  let lib: ReturnType<typeof library>
  try {
    lib = library()
  } catch {
    return []
  }
  const seen = new Set<string>()
  const out: LibraryDoc[] = []
  const add = (docs: LibraryDoc[]) => {
    for (const d of docs) {
      if (out.length >= MAX_DOCS) return
      if (seen.has(d.id)) continue
      seen.add(d.id)
      out.push(d)
    }
  }
  add(lib.search(text, 40))
  const current = useStore.getState().libraryLocation
  const order: Location[] = [current, ...SHELVES.map((s) => s.id).filter((l) => l !== current)]
  for (const location of order) add(lib.inLocation(location).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)))
  return out.map((d) => ({ id: d.id, title: d.title, author: d.author }))
}

/** The decision, as an action the app can take — or null when it isn't sure enough. */
export function toAction(d: Decision, partial: boolean): NavAction | null {
  if (d.confidence < (partial ? PARTIAL_BAR : FINAL_BAR)) return null
  switch (d.intent) {
    case 'open':
      return d.doc && d.doc.confidence >= TARGET_BAR ? { kind: 'open', id: d.doc.id } : null
    case 'chapter':
      return d.chapter && d.chapter.confidence >= TARGET_BAR ? { kind: 'chapter', index: d.chapter.index } : null
    case 'file': {
      const shelf = SHELVES.find((s) => s.id === d.shelf?.id)
      return shelf && d.shelf && d.shelf.confidence >= TARGET_BAR ? { kind: 'file', shelf: shelf.id } : null
    }
    case 'list':
    case 'next_chapter':
    case 'previous_chapter':
    case 'beginning':
    case 'close':
    case 'pause':
    case 'resume':
      return { kind: d.intent }
    default:
      return null
  }
}

/**
 * Ask the server what this means. Null means "not sure, or not available":
 * the caller goes to the conversation. Never throws — a failed decision is
 * just a slow path, not an error the reader should hear about.
 */
export async function decide(text: string, partial: boolean): Promise<NavAction | null> {
  if (Date.now() < disabledUntil) return null
  const s = useStore.getState()
  const chapters = s.doc && s.doc.chapters.length > 1 ? s.doc.chapters.map((c) => c.title) : undefined
  const at = s.paragraphs[Math.min(s.currentParagraph, s.paragraphs.length - 1)]
  const body = {
    text,
    partial,
    screen: s.doc ? 'document' : 'library',
    docs: candidates(text),
    chapters,
    open: s.doc ? { title: s.doc.title, chapter: at ? s.doc.chapters[at.chapterIndex]?.title ?? null : null } : null,
    shelves: s.doc ? SHELVES.filter((sh) => sh.id !== s.libraryDoc?.location) : undefined,
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(`${apiBase}/api/navigate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (res.status === 404) {
      disabledUntil = Date.now() + DISABLED_FOR_MS // an older server without the route
      return null
    }
    if (!res.ok) return null
    const json = (await res.json()) as { enabled: boolean; decision?: Decision }
    if (!json.enabled || !json.decision) {
      disabledUntil = Date.now() + DISABLED_FOR_MS
      return null
    }
    return toAction(json.decision, partial)
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
