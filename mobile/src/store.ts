// Port of the web store (src/store.ts), minus the fact-check job cards and
// document-scan progress — on mobile a verdict is spoken and lands in the chat.
import { create } from 'zustand'
import type { ChatMessage, Doc, FlatParagraph, Highlight } from './types'

interface State {
  doc: Doc | null
  paragraphs: FlatParagraph[]
  currentParagraph: number
  playing: boolean
  rate: number
  micEnabled: boolean
  agentState: 'idle' | 'listening' | 'thinking' | 'speaking' | 'reading'
  chat: ChatMessage[]
  highlights: Highlight[]
  notice: string | null

  setDoc: (doc: Doc) => void
  clearDoc: () => void
  setRate: (r: number) => void
  pushChat: (m: ChatMessage) => void
  updateChat: (id: string, patch: Partial<ChatMessage>) => void
  addHighlight: (h: Highlight) => void
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
  doc: null,
  paragraphs: [],
  currentParagraph: 0,
  playing: false,
  rate: 1,
  micEnabled: false,
  agentState: 'idle',
  chat: [],
  highlights: [],
  notice: null,

  setDoc: (doc) =>
    set({ doc, paragraphs: flatten(doc), currentParagraph: 0, playing: false, chat: [], highlights: [] }),
  clearDoc: () => set({ doc: null, paragraphs: [], playing: false, chat: [], highlights: [] }),
  setRate: (rate) => set({ rate }),
  pushChat: (m) => set((s) => ({ chat: [...s.chat, m] })),
  updateChat: (id, patch) =>
    set((s) => ({ chat: s.chat.map((m) => (m.id === id ? { ...m, ...patch } : m)) })),
  addHighlight: (h) => set((s) => ({ highlights: [h, ...s.highlights] })),
  setNotice: (notice) => set({ notice }),
}))
