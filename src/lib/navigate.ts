// Fast navigation inside the open document: "skip to chapter three", "hold
// on", "keep going", "from the top" decided in one short round trip by the
// server's decision model (/api/navigate) instead of a conversation turn. The
// app acts on a confident answer at once; anything unsure goes to the
// conversation as before. Asked on partial transcripts too, where the time
// really goes: the recognizer waits for silence before it finalizes, and the
// words are clear well before then. A partial holds a higher bar.
//
// The phone's version (mobile/src/navigate.ts) also knows the library; here
// the document is the whole world.
import { useStore } from '../store'

export type NavAction =
  | { kind: 'chapter'; index: number }
  | { kind: 'next_chapter' }
  | { kind: 'previous_chapter' }
  | { kind: 'beginning' }
  | { kind: 'pause' }
  | { kind: 'resume' }

export interface Decision {
  intent: string
  confidence: number
  chapter?: { index: number; confidence: number }
}

export const FINAL_BAR = 0.6
export const PARTIAL_BAR = 0.8
export const TARGET_BAR = 0.5
const TIMEOUT_MS = 2500
const DISABLED_FOR_MS = 5 * 60 * 1000

let disabledUntil = 0

export function toAction(d: Decision, partial: boolean): NavAction | null {
  if (d.confidence < (partial ? PARTIAL_BAR : FINAL_BAR)) return null
  switch (d.intent) {
    case 'chapter':
      return d.chapter && d.chapter.confidence >= TARGET_BAR ? { kind: 'chapter', index: d.chapter.index } : null
    case 'next_chapter':
    case 'previous_chapter':
    case 'beginning':
    case 'pause':
    case 'resume':
      return { kind: d.intent }
    default:
      return null
  }
}

/** Null means "not sure, or not available": go to the conversation. Never throws. */
export async function decide(text: string, partial: boolean): Promise<NavAction | null> {
  if (Date.now() < disabledUntil) return null
  const s = useStore.getState()
  if (!s.doc) return null
  const at = s.paragraphs[Math.min(s.currentParagraph, s.paragraphs.length - 1)]
  const body = {
    text,
    partial,
    screen: 'document',
    chapters: s.doc.chapters.length > 1 ? s.doc.chapters.map((c) => c.title) : undefined,
    open: { title: s.doc.title, chapter: at ? s.doc.chapters[at.chapterIndex]?.title ?? null : null },
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch('/api/navigate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (res.status === 404) {
      disabledUntil = Date.now() + DISABLED_FOR_MS
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
