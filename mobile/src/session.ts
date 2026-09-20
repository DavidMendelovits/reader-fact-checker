// The use-cases behind both the screens and the agent's tools: sign in, sync
// the library, open and close a document, file it, highlight it. Neither the
// UI nor the agent talks to the Library or the store's persistence directly;
// they call these, so a voice command and a tap do exactly the same thing.
import { LibraryService } from './library'
import { anchorText } from './highlights'
import { htmlToChapters } from './html'
import { readwiseLibrary } from './readwise'
import { asyncStore } from './storage'
import { useStore } from './store'
import { tts } from './providers'
import type { Doc, DocState, Highlight, LibraryDoc, Location } from './types'

let service: LibraryService | null = null

/** The library service for the signed-in token. Throws before sign-in. */
export function library(): LibraryService {
  if (!service) throw new Error('Not signed in to Readwise.')
  return service
}

let counter = 0
const newId = () => `h-${Date.now()}-${++counter}`

/** Sign in: restore the cached library instantly, then pull changes in the background. */
export async function startLibrary(token: string): Promise<void> {
  // EXPO_PUBLIC_READWISE_BASE points the app at a stand-in Reader for a local
  // run (the web smoke test); unset, which is every real build, it's Readwise.
  const base = process.env.EXPO_PUBLIC_READWISE_BASE
  const lib = base ? readwiseLibrary(token, { readerBase: `${base}/api/v3`, readwiseBase: `${base}/api/v2` }) : readwiseLibrary(token)
  service = new LibraryService(lib, asyncStore)
  service.onChange = () => useStore.getState().setLibrary(service!.docs, service!.sync.lastSync)
  await service.load()
  void refreshLibrary()
}

export function stopLibrary(): void {
  service = null
  useStore.getState().setLibrary([], null)
}

export async function refreshLibrary(opts: { full?: boolean } = {}): Promise<void> {
  const s = useStore.getState()
  if (s.syncing) return
  s.setSyncing(true)
  s.setSyncError(null)
  try {
    await library().refresh(opts)
  } catch {
    // Not a toast: a failed sync is not an emergency, the cached library is
    // still on screen. The hairline under the tabs goes red and the Composer's
    // line says so, because the line is where the app talks (Pass 2).
    const st = useStore.getState()
    st.setSyncError(Date.now())
    st.pushChat({ id: newId(), role: 'assistant', text: "Couldn't sync. Showing what's saved." })
  } finally {
    useStore.getState().setSyncing(false)
  }
}

// ---- the open document ----

let openId: string | null = null
let state: DocState | null = null
let saveTimer: ReturnType<typeof setTimeout> | null = null

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => void persist(), 800)
}

async function persist(): Promise<void> {
  if (!openId || !state) return
  const st = useStore.getState()
  state.position = st.currentParagraph
  state.highlights = st.highlights
  await library().saveDocState(openId, state)
}

/**
 * Open a document from the library: fetch its text, split it into chapters,
 * restore where the reader left off, and paint the highlights — the phone's own
 * plus any Reader has that the phone hasn't seen. Resolves with the position so
 * the caller can say "picking up at chapter three".
 */
export async function openDocument(id: string): Promise<{ doc: Doc; libraryDoc: LibraryDoc; position: number }> {
  const lib = library()
  // fetch and check first: "open the report" must not put the book away when
  // the report turns out to be a PDF with no text
  const { doc: libraryDoc, html } = await lib.fetchHtml(id)
  if (!html) throw new Error(`Reader has no readable text for "${libraryDoc.title}" (it may be a PDF or a video).`)
  const chapters = htmlToChapters(html, libraryDoc.title)
  const paragraphs = chapters.flatMap((c) => c.paragraphs)
  if (paragraphs.length === 0) throw new Error(`"${libraryDoc.title}" has no readable text.`)
  const doc: Doc = { id, title: libraryDoc.title, source: libraryDoc.sourceUrl ?? 'Readwise Reader', chapters }
  await closeDocument()

  const saved = await lib.docState(id)
  // Reader-side highlights the phone hasn't folded in: anchor and adopt them
  const fresh = lib.newRemoteHighlights(id, saved)
  const adopted: Highlight[] = fresh.map((r) => ({
    id: newId(),
    remoteId: r.id,
    text: r.text,
    note: r.note ?? undefined,
    anchor: anchorText(paragraphs, r.text),
    createdAt: Date.parse(r.updatedAt) || Date.now(),
  }))
  // and re-anchor the phone's own, in case the text changed under them
  const own = saved.highlights.map((h) => ({ ...h, anchor: h.anchor ?? anchorText(paragraphs, h.text) }))
  state = {
    ...saved,
    highlights: [...own, ...adopted],
    mergedRemote: [...saved.mergedRemote, ...fresh.map((r) => r.id)],
  }
  openId = id
  useStore.getState().setDoc(doc, libraryDoc, saved.position, state.highlights)
  tts.setParagraphs(paragraphs)
  await lib.saveDocState(id, state)
  // anything that didn't reach Readwise last time
  void lib.flush(libraryDoc, state).then((flushed) => {
    if (openId !== id) return
    state = flushed
    useStore.getState().setHighlights(flushed.highlights)
    scheduleSave()
  })
  return { doc, libraryDoc, position: useStore.getState().currentParagraph }
}

/** Put the document away: stop the voice, remember the position, back to the library. */
export async function closeDocument(): Promise<void> {
  if (!openId) return
  tts.pause()
  if (saveTimer) clearTimeout(saveTimer)
  await persist()
  openId = null
  state = null
  useStore.getState().clearDoc()
}

/** Remember the position as it moves. Wired to the player once, in providers. */
export function positionChanged(): void {
  if (openId) scheduleSave()
}

export async function moveDocument(id: string, location: Location): Promise<LibraryDoc> {
  const known = library().byId(id)
  if (!known) throw new Error('That document is not in the library.')
  await library().move(id, location)
  const doc = library().byId(id) ?? known
  if (useStore.getState().libraryDoc?.id === id) useStore.setState({ libraryDoc: doc })
  return doc
}

// ---- highlights ----

/**
 * Highlight a passage of the open document. Painted at once; written to
 * Readwise in the background and retried later if that fails.
 */
export async function addHighlight(input: { text: string; note?: string; near?: number }): Promise<Highlight> {
  const st = useStore.getState()
  if (!openId || !st.libraryDoc) throw new Error('No document is open.')
  const paragraphs = st.paragraphs.map((p) => p.text)
  const anchor = anchorText(paragraphs, input.text, input.near)
  const h: Highlight = {
    id: newId(),
    text: anchor ? paragraphs[anchor.paragraph].slice(anchor.start, anchor.end) : input.text.trim(),
    note: input.note?.trim() || undefined,
    anchor,
    createdAt: Date.now(),
    pending: 'create',
  }
  st.setHighlights([...st.highlights, h])
  scheduleSave()
  const id = openId
  const libraryDoc = st.libraryDoc
  void library()
    .pushHighlight(libraryDoc, h)
    .then((written) => {
      if (openId !== id) return
      const s = useStore.getState()
      s.setHighlights(s.highlights.map((x) => (x.id === h.id ? written : x)))
      scheduleSave()
    })
  return h
}

/** Highlight a whole paragraph — the long-press gesture, and "highlight that" with nothing more specific. */
export function highlightParagraph(index: number, note?: string): Promise<Highlight> {
  const p = useStore.getState().paragraphs[index]
  if (!p) throw new Error('No such paragraph.')
  return addHighlight({ text: p.text, note, near: index })
}

export async function removeHighlight(id: string): Promise<void> {
  const st = useStore.getState()
  const h = st.highlights.find((x) => x.id === id)
  if (!h) return
  st.setHighlights(st.highlights.filter((x) => x.id !== id))
  scheduleSave()
  const left = await library().removeHighlight(h)
  if (left) {
    // couldn't reach Readwise: keep a tombstone so flush() retries the delete
    const s = useStore.getState()
    s.setHighlights([...s.highlights, { ...left, anchor: null }])
    scheduleSave()
  }
}

export async function setHighlightNote(id: string, note: string): Promise<void> {
  const st = useStore.getState()
  st.setHighlights(st.highlights.map((h) => (h.id === id ? { ...h, note: note.trim() || undefined } : h)))
  scheduleSave()
  // ponytail: the note lives on the phone; Readwise's v2 API has no highlight-update call
}
