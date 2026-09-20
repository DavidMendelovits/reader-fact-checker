// One store for the whole app. Two halves: the library (what Reader has, which
// tab, what's being searched) and the open document (text, position, playback,
// the conversation, the highlights). `screen` says which is on show.
import { create } from 'zustand'
import type { ChatMessage, Doc, FlatParagraph, Highlight, LibraryDoc, Location } from './types'

export type Screen = 'library' | 'reader' | 'settings'
export type AgentState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'reading'
/**
 * What the Composer's mic button shows. `notAsked` is a fresh install — the OS
 * prompts fire on the first tap, not at sign-in (3.1A); `denied` comes from the
 * recognizer's error, and only Settings can undo it; `restarting` is the
 * recognizer having died three times in thirty seconds (Pass 2), where the mic
 * turns amber and a tap tries again.
 */
export type MicState = 'notAsked' | 'live' | 'muted' | 'denied' | 'off' | 'restarting'

interface State {
  screen: Screen

  // ---- library ----
  library: LibraryDoc[]
  libraryLocation: Location
  libraryQuery: string
  syncing: boolean
  lastSync: string | null
  /** When the last sync failed, in ms. The library's hairline reads red for 2s after it. */
  syncError: number | null

  // ---- the open document ----
  doc: Doc | null
  /** Reader's record for the open document; null when nothing is open. */
  libraryDoc: LibraryDoc | null
  paragraphs: FlatParagraph[]
  currentParagraph: number
  playing: boolean
  rate: number
  micEnabled: boolean
  micState: MicState
  agentState: AgentState
  chat: ChatMessage[]
  /** The agent's last line, and when it landed: the Composer's line holds it for 3s. */
  lastAgentLine: string | null
  lastAgentLineAt: number | null
  /** The transcript as it is being spoken. Only the Composer reads it. */
  interim: string
  /**
   * True while the on-device voice is being loaded at boot. It is the line's
   * business, not the chat's: Play works on the system voice meanwhile, so this
   * never becomes a message (Pass 2, Voice model).
   */
  voiceLoading: boolean
  highlights: Highlight[]
  notice: string | null

  setScreen: (screen: Screen) => void
  setLibrary: (docs: LibraryDoc[], lastSync: string | null) => void
  setLibraryLocation: (location: Location) => void
  setLibraryQuery: (query: string) => void
  setSyncing: (syncing: boolean) => void
  setSyncError: (at: number | null) => void

  setDoc: (doc: Doc, libraryDoc: LibraryDoc, position: number, highlights: Highlight[]) => void
  clearDoc: () => void
  setCurrentParagraph: (i: number) => void
  setRate: (r: number) => void
  setMicEnabled: (on: boolean) => void
  setMicState: (m: MicState) => void
  setAgentState: (s: AgentState) => void
  pushChat: (m: ChatMessage) => void
  setInterim: (t: string) => void
  setVoiceLoading: (loading: boolean) => void
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
  syncError: null,

  doc: null,
  libraryDoc: null,
  paragraphs: [],
  currentParagraph: 0,
  playing: false,
  rate: 1,
  micEnabled: false,
  micState: 'notAsked',
  agentState: 'idle',
  chat: [],
  lastAgentLine: null,
  lastAgentLineAt: null,
  interim: '',
  voiceLoading: false,
  highlights: [],
  notice: null,

  setScreen: (screen) => set({ screen }),
  setLibrary: (library, lastSync) => set({ library, lastSync }),
  setLibraryLocation: (libraryLocation) => set({ libraryLocation }),
  setLibraryQuery: (libraryQuery) => set({ libraryQuery }),
  setSyncing: (syncing) => set({ syncing }),
  setSyncError: (syncError) => set({ syncError }),

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
    set({ doc: null, libraryDoc: null, paragraphs: [], currentParagraph: 0, playing: false, highlights: [], screen: 'library', lastAgentLine: null, lastAgentLineAt: null }),
  setCurrentParagraph: (currentParagraph) => set({ currentParagraph }),
  setRate: (rate) => set({ rate }),
  setMicEnabled: (micEnabled) => set({ micEnabled }),
  setMicState: (micState) => set({ micState }),
  setAgentState: (agentState) => set({ agentState }),
  // The agent's line is tracked here rather than derived: the Composer would
  // otherwise have to subscribe to the whole chat array to find the last of it.
  pushChat: (m) =>
    set((s) => ({
      chat: [...s.chat, m],
      ...(m.role === 'assistant' && m.text.trim()
        ? { lastAgentLine: m.text, lastAgentLineAt: Date.now() }
        : null),
    })),
  setInterim: (interim) => set({ interim }),
  setVoiceLoading: (voiceLoading) => set({ voiceLoading }),
  updateChat: (id, patch) =>
    set((s) => ({ chat: s.chat.map((m) => (m.id === id ? { ...m, ...patch } : m)) })),
  setHighlights: (highlights) => set({ highlights }),
  setNotice: (notice) => set({ notice }),
}))
