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
  /** The browser refused the mic. Sticky until the mic actually comes up again. */
  micDenied: boolean
  // 'listening' = we heard speech start, transcript not in yet. Note that 'reading'
  // only means the read tool is in flight — `playing` is the truth about audio.
  agentState: 'idle' | 'listening' | 'thinking' | 'speaking' | 'reading'
  chat: ChatMessage[]
  /** Words the recognizer has heard but not finalised. Only the Composer line reads it. */
  interim: string
  /** The last thing the agent said, and when — the Composer line holds it for a beat. */
  lastAgentLine: string | null
  lastAgentLineAt: number | null
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
  setMicDenied: (d: boolean) => void
  setInterim: (t: string) => void
  pushChat: (m: ChatMessage) => void
  updateChat: (id: string, patch: Partial<ChatMessage>) => void
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
  micDenied: false,
  agentState: 'idle',
  chat: [],
  interim: '',
  lastAgentLine: null,
  lastAgentLineAt: null,
  jobs: [],
  highlights: [],
  docCheckProgress: null,
  notice: null,

  setDoc: (doc) => set({ doc, paragraphs: flatten(doc), currentParagraph: 0, playing: false, jobs: [], highlights: [], chat: [], interim: '', lastAgentLine: null, lastAgentLineAt: null, docCheckProgress: null }),
  clearDoc: () => set({ doc: null, paragraphs: [], playing: false, jobs: [], highlights: [], chat: [], interim: '', lastAgentLine: null, lastAgentLineAt: null, docCheckProgress: null }),
  setCurrentParagraph: (currentParagraph) => set({ currentParagraph }),
  setPlaying: (playing) => set({ playing }),
  setRate: (rate) => set({ rate }),
  setMicEnabled: (micEnabled) => set({ micEnabled }),
  setMicDenied: (micDenied) => set({ micDenied }),
  setInterim: (interim) => set({ interim }),
  // The line shows the agent's last reply, so the Composer never has to walk the
  // chat log backwards to find it.
  pushChat: (m) =>
    set((s) => ({
      chat: [...s.chat, m],
      ...(m.role === 'assistant' ? { lastAgentLine: m.text, lastAgentLineAt: Date.now() } : null),
    })),
  // A streamed reply arrives as a push of its first words and then a run of
  // patches, so the line has to follow the patches too or it keeps the first chunk.
  updateChat: (id, patch) =>
    set((s) => {
      const before = s.chat.find((m) => m.id === id)
      const chat = s.chat.map((m) => (m.id === id ? { ...m, ...patch } : m))
      if (patch.text === undefined || before?.role !== 'assistant') return { chat }
      // The timestamp is when the line landed, not when it last grew: a stream is
      // dozens of patches to the message the Composer is already holding, and
      // bumping on each of them would hold the line open forever. It only moves
      // when the patch makes some other message the agent line.
      if (s.lastAgentLine === before.text) return { chat, lastAgentLine: patch.text }
      return { chat, lastAgentLine: patch.text, lastAgentLineAt: Date.now() }
    }),
  addJob: (job) => set((s) => ({ jobs: [job, ...s.jobs] })),
  addHighlight: (h) => set((s) => ({ highlights: [h, ...s.highlights] })),
  removeHighlight: (id) => set((s) => ({ highlights: s.highlights.filter((h) => h.id !== id) })),
  updateJob: (id, patch) =>
    set((s) => ({ jobs: s.jobs.map((j) => (j.id === id ? { ...j, ...patch } : j)) })),
  setDocCheckProgress: (docCheckProgress) => set({ docCheckProgress }),
  setNotice: (notice) => set({ notice }),
}))
