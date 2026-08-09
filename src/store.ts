import { create } from 'zustand'
import type { ChatMessage, Doc, FactCheckJob, FlatParagraph, Highlight } from './types'

interface State {
  doc: Doc | null
  paragraphs: FlatParagraph[] // flattened for position tracking
  // player
  currentParagraph: number
  playing: boolean
  rate: number
  // voice agent
  micEnabled: boolean
  micMuted: boolean
  // 'listening' = we heard speech start, transcript not in yet. Note that 'reading'
  // only means the read tool is in flight — `playing` is the truth about audio.
  agentState: 'idle' | 'listening' | 'thinking' | 'speaking' | 'reading'
  chat: ChatMessage[]
  // jobs
  jobs: FactCheckJob[]
  highlights: Highlight[]
  docCheckProgress: { done: number; total: number } | null
  // transient user-facing message (mic denied, etc.) — native alert() is blocked
  // in iframes/embedded webviews, so we render it ourselves
  notice: string | null

  setDoc: (doc: Doc) => void
  clearDoc: () => void
  setCurrentParagraph: (i: number) => void
  setPlaying: (p: boolean) => void
  setRate: (r: number) => void
  setMicEnabled: (m: boolean) => void
  pushChat: (m: ChatMessage) => void
  addJob: (job: FactCheckJob) => void
  addHighlight: (h: Highlight) => void
  removeHighlight: (id: string) => void
  updateJob: (id: string, patch: Partial<FactCheckJob>) => void
  setDocCheckProgress: (p: State['docCheckProgress']) => void
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
  micMuted: false,
  agentState: 'idle',
  chat: [],
  jobs: [],
  highlights: [],
  docCheckProgress: null,
  notice: null,

  setDoc: (doc) => set({ doc, paragraphs: flatten(doc), currentParagraph: 0, playing: false, jobs: [], highlights: [], chat: [], docCheckProgress: null }),
  clearDoc: () => set({ doc: null, paragraphs: [], playing: false, jobs: [], highlights: [], chat: [], docCheckProgress: null }),
  setCurrentParagraph: (currentParagraph) => set({ currentParagraph }),
  setPlaying: (playing) => set({ playing }),
  setRate: (rate) => set({ rate }),
  setMicEnabled: (micEnabled) => set({ micEnabled }),
  pushChat: (m) => set((s) => ({ chat: [...s.chat, m] })),
  addJob: (job) => set((s) => ({ jobs: [job, ...s.jobs] })),
  addHighlight: (h) => set((s) => ({ highlights: [h, ...s.highlights] })),
  removeHighlight: (id) => set((s) => ({ highlights: s.highlights.filter((h) => h.id !== id) })),
  updateJob: (id, patch) =>
    set((s) => ({ jobs: s.jobs.map((j) => (j.id === id ? { ...j, ...patch } : j)) })),
  setDocCheckProgress: (docCheckProgress) => set({ docCheckProgress }),
  setNotice: (notice) => set({ notice }),
}))
