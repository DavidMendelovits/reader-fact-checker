// Local library: every imported document keeps its position, fact checks,
// highlights, and conversation across reloads.
//
// The extracted text is stored too, so an EPUB resumes without re-uploading the
// file. That is also what makes this the tight resource: localStorage is ~5MB, and
// a full book is a few hundred KB, so writes evict the oldest entries until they
// fit rather than failing.
import { useStore } from '../store'
import { exportMessages, keepConversation, markReopened, restoreMessages } from './agent'
import { tts } from './providers'
import type { ChatMessage, Doc, FactCheckJob, Highlight } from '../types'

const KEY = 'rfc-library'
const MAX_ENTRIES = 8
const SAVE_DEBOUNCE = 800

export interface LibraryEntry {
  id: string
  title: string
  source: string
  doc: Doc
  currentParagraph: number
  jobs: FactCheckJob[]
  highlights: Highlight[]
  chat: ChatMessage[]
  agentMessages: unknown[]
  updatedAt: number
}

export function loadLibrary(): LibraryEntry[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    if (!Array.isArray(raw)) return []
    return (raw as LibraryEntry[])
      .filter((e) => e?.id && e?.doc?.chapters)
      .sort((a, b) => b.updatedAt - a.updatedAt)
  } catch {
    return []
  }
}

function writeLibrary(entries: LibraryEntry[]) {
  const ordered = entries.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_ENTRIES)
  // drop the oldest entry and retry until the write fits under the quota
  for (let n = ordered.length; n > 0; n--) {
    try {
      localStorage.setItem(KEY, JSON.stringify(ordered.slice(0, n)))
      return
    } catch {
      /* QuotaExceededError — try again with fewer */
    }
  }
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* nothing more we can do */
  }
}

function save() {
  const s = useStore.getState()
  if (!s.doc) return
  const entry: LibraryEntry = {
    id: s.doc.id,
    title: s.doc.title,
    source: s.doc.source,
    doc: s.doc,
    currentParagraph: s.currentParagraph,
    jobs: s.jobs,
    highlights: s.highlights,
    chat: s.chat,
    agentMessages: exportMessages(),
    updatedAt: Date.now(),
  }
  writeLibrary([entry, ...loadLibrary().filter((e) => e.id !== entry.id)])
}

/** Save the open document now, not after the debounce: it is about to be put away. */
export function saveNow() {
  if (timer) clearTimeout(timer)
  timer = null
  save()
}

export function forgetEntry(id: string) {
  writeLibrary(loadLibrary().filter((e) => e.id !== id))
}

/**
 * A saved document's checks. One that was running when the page closed will
 * never finish, and a verdict that was still queued will never be read out.
 */
const restoredJobs = (entry: LibraryEntry | undefined): FactCheckJob[] =>
  (entry?.jobs ?? []).map((j) =>
    j.status === 'running' ? { ...j, status: 'error' as const, error: 'Interrupted' } : j.spoken === undefined ? { ...j, spoken: false } : j,
  )

/** Reopen a saved document with its position, cards, and conversation intact. */
export function openEntry(entry: LibraryEntry) {
  tts.clearCacheForNewDoc()
  useStore.getState().setDoc(entry.doc) // resets jobs/chat, and clears the agent conversation
  useStore.setState({
    currentParagraph: entry.currentParagraph ?? 0,
    jobs: restoredJobs(entry),
    highlights: entry.highlights ?? [],
    chat: entry.chat ?? [],
  })
  restoreMessages(entry.agentMessages ?? [])
  // After setDoc, which clears the mark along with the conversation. The doc-open
  // turn in controller.ts reads it a tick later and opens with a recap.
  markReopened(entry.updatedAt ?? Date.now())
}

/**
 * Switch documents in the middle of a conversation: "switch to the Hemingway
 * one". Unlike openEntry, the conversation and the chat carry on (the switch is
 * a tool call, and its result has to land in the same turn), and the reading
 * position is the one asked for. The document's own cards and highlights come
 * back with it.
 */
export function switchTo(doc: Doc, entry: LibraryEntry | undefined, at: number) {
  saveNow()
  const chat = useStore.getState().chat
  tts.clearCacheForNewDoc()
  keepConversation()
  useStore.getState().setDoc(doc)
  useStore.setState({
    currentParagraph: at,
    jobs: restoredJobs(entry),
    highlights: entry?.highlights ?? [],
    chat,
  })
}

let timer: ReturnType<typeof setTimeout> | null = null
useStore.subscribe((s, prev) => {
  if (!s.doc) return
  const changed =
    s.doc !== prev.doc ||
    s.currentParagraph !== prev.currentParagraph ||
    s.jobs !== prev.jobs ||
    s.highlights !== prev.highlights ||
    s.chat !== prev.chat
  if (!changed) return
  if (timer) clearTimeout(timer)
  timer = setTimeout(save, SAVE_DEBOUNCE)
})

// a reload mid-sentence shouldn't lose the last few seconds
window.addEventListener('beforeunload', save)
