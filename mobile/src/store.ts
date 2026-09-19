// One store for the whole app. Two halves: the library (what Reader has, which
// tab, what's being searched) and the open document (text, position, playback,
// the conversation, the highlights). `screen` says which is on show.
import { create } from 'zustand'
import type { ChatMessage, Doc, FlatParagraph, Highlight, LibraryDoc, Location } from './types'

export type Screen = 'library' | 'reader' | 'settings'
export type AgentState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'reading'

interface State {
  screen: Screen

  // ---- library ----
  library: LibraryDoc[]
  libraryLocation: Location
  libraryQuery: string
  syncing: boolean
  lastSync: string | null

  // ---- the open document ----
  doc: Doc | null
  /** Reader's record for the open document; null when nothing is open. */
  libraryDoc: LibraryDoc | null
  paragraphs: FlatParagraph[]
  currentParagraph: number
  playing: boolean
  rate: number
  micEnabled: boolean
  agentState: AgentState
  chat: ChatMessage[]
  highlights: Highlight[]
  notice: string | null

  setScreen: (screen: Screen) => void
  setLibrary: (docs: LibraryDoc[], lastSync: string | null) => void
  setLibraryLocation: (location: Location) => void
  setLibraryQuery: (query: string) => void
  setSyncing: (syncing: boolean) => void

  setDoc: (doc: Doc, libraryDoc: LibraryDoc, position: number, highlights: Highlight[]) => void
  clearDoc: () => void
  setCurrentParagraph: (i: number) => void
  setRate: (r: number) => void
  setMicEnabled: (on: boolean) => void
  setAgentState: (s: AgentState) => void
  pushChat: (m: ChatMessage) => void
  updateChat: (id: string, patch: Partial<ChatMessage>) => void
  setHighlights: (highlights: Highlight[]) => void
  setNotice: (n: string | null) => void
}

function flatten(doc: Doc): FlatParagraph[] {
  const out: FlatParagraph[] = []
  doc.chapters.forEach((ch, chapterIndex) => {
    ch.paragraphs.forEach((text, paragraphIndex) => {
      out.push({ chapterIndex, paragraphIndex, text })
    })
  })
  return out
}

export const useStore = create<State>((set) => ({
  screen: 'library',

  library: [],
  libraryLocation: 'new',
  libraryQuery: '',
  syncing: false,
  lastSync: null,

  doc: null,
  libraryDoc: null,
  paragraphs: [],
  currentParagraph: 0,
  playing: false,
  rate: 1,
  micEnabled: false,
  agentState: 'idle',
  chat: [],
  highlights: [],
  notice: null,

  setScreen: (screen) => set({ screen }),
  setLibrary: (library, lastSync) => set({ library, lastSync }),
  setLibraryLocation: (libraryLocation) => set({ libraryLocation }),
  setLibraryQuery: (libraryQuery) => set({ libraryQuery }),
  setSyncing: (syncing) => set({ syncing }),

  setDoc: (doc, libraryDoc, position, highlights) => {
    const paragraphs = flatten(doc)
    set({
      doc,
      libraryDoc,
      paragraphs,
      currentParagraph: Math.max(0, Math.min(position, paragraphs.length - 1)),
      playing: false,
      highlights,
      screen: 'reader',
    })
  },
  clearDoc: () =>
    set({ doc: null, libraryDoc: null, paragraphs: [], currentParagraph: 0, playing: false, highlights: [], screen: 'library' }),
  setCurrentParagraph: (currentParagraph) => set({ currentParagraph }),
  setRate: (rate) => set({ rate }),
  setMicEnabled: (micEnabled) => set({ micEnabled }),
  setAgentState: (agentState) => set({ agentState }),
  pushChat: (m) => set((s) => ({ chat: [...s.chat, m] })),
  updateChat: (id, patch) =>
    set((s) => ({ chat: s.chat.map((m) => (m.id === id ? { ...m, ...patch } : m)) })),
  setHighlights: (highlights) => set({ highlights }),
  setNotice: (notice) => set({ notice }),
}))
