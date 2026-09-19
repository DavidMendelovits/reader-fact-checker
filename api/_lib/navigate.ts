// Navigation without the conversation model in the loop. "Open the Hemingway
// one", "skip to chapter three", "archive that", "back to the library" used to
// be a model turn — several seconds of silence, sometimes two turns (search,
// then open) — for a decision that has one right answer among a short list. A
// decision model answers the whole thing in one call: what kind of request this
// is, and which document, chapter or shelf it names. The client acts on a
// confident answer at once and hands anything else to the conversation as
// before, so the worst case is exactly what it was.
//
// The lists are the client's: it knows its library and the open document, and
// sends the candidates (ids and titles, nothing more). Nothing here is Reader-
// or phone-specific; the web app uses the same route for its chapters.
import type { DecisionQuestion, Decider } from './ports.js'
import { providers } from './providers.js'

export type Screen = 'library' | 'document'

export interface NavigateRequest {
  /** What the reader said. */
  text: string
  screen: Screen
  /** Documents the reader might mean, most likely first: `[id] title — author`. Up to 200. */
  docs?: { id: string; title: string; author?: string | null }[]
  /** The open document's chapter titles, in order. Up to 200. */
  chapters?: string[]
  /** The open document's title, for the state. */
  open?: { title: string; chapter?: string | null } | null
  /** Shelves a document can be filed on, if the client has any. */
  shelves?: { id: string; label: string }[]
  /**
   * The transcript is still being recognized: the reader may not have finished
   * the sentence. The client asks on partials so a confident answer can act
   * before the recognizer's end-of-speech wait, and holds a higher bar for it.
   */
  partial?: boolean
}

export type Intent =
  | 'open' // open a document from the library
  | 'list' // what's new, what's on the shelf
  | 'chapter' // go to a named or numbered chapter
  | 'next_chapter'
  | 'previous_chapter'
  | 'beginning' // start the document over
  | 'close' // put the document away, back to the library
  | 'file' // move the open document to another shelf
  | 'pause' // stop the voice
  | 'resume' // carry on reading
  | 'other' // a question, a remark, anything for the conversation

export interface NavigateDecision {
  intent: Intent
  /** Confidence in the intent, 0..1. */
  confidence: number
  /** Filled for `open`: which document, and how sure. */
  doc?: { id: string; confidence: number }
  /** Filled for `chapter`: which chapter index, and how sure. */
  chapter?: { index: number; confidence: number }
  /** Filled for `file`: which shelf, and how sure. */
  shelf?: { id: string; confidence: number }
  model: string
}

const MAX_OPTIONS = 200

const LIBRARY_INTENTS: Record<string, string> = {
  open: 'The reader wants to open, read, play, or start a particular document, book, or article — named by title, author, topic, or "the newest one".',
  list: 'The reader asks what is in the library or on a shelf: what\'s new, what have I saved, what\'s in the inbox, what\'s in the archive, read me the list.',
  other: 'Anything else: a question, a remark, a greeting, a request about something other than opening or listing documents.',
}

const DOCUMENT_INTENTS: Record<string, string> = {
  chapter: 'Go to a specific chapter or section of this document, named by its number or its title ("chapter three", "the part about the harbour", "the introduction").',
  next_chapter: 'Skip ahead to the next chapter or section.',
  previous_chapter: 'Go back to the previous chapter, or restart the current one ("back to the start of this chapter").',
  beginning: 'Start the document over from the very beginning.',
  close: 'Put this document away and go back to the library: "back to the library", "close this", "I\'m done with this one", "show me my books".',
  file: 'File this document on another shelf: archive it, save it for later, put it back in the inbox.',
  open: 'Open a different document, book, or article from the library instead of this one.',
  pause: 'Stop or pause the voice, or ask it to wait: "stop", "hold on", "wait a moment", "that\'s enough for now", "shush", "hang on".',
  resume: 'Carry on reading from where it stopped: "keep going", "continue", "go on", "read", "resume", "carry on".',
  other: 'Anything else: a question about the text, "is that true", "highlight that", a remark, speed, going back a bit, rereading a sentence, anything not listed.',
}

/** Words the reader uses for the shelves. */
const SHELF_HINTS: Record<string, string> = {
  new: 'The inbox: "put it back in the inbox", "move it to new", "unarchive it".',
  later: 'Save for later: "save it for later", "read it later", "later".',
  archive: 'The archive: "archive that", "I\'m done with it, file it", "archive it".',
}

export function buildQuestions(req: NavigateRequest): Record<string, DecisionQuestion> {
  const questions: Record<string, DecisionQuestion> = {
    intent: {
      type: 'choice',
      instructions: 'What is the reader asking the app to do? They are using a voice-driven reader; the text is a speech transcript.',
      criteria: req.screen === 'library' ? LIBRARY_INTENTS : DOCUMENT_INTENTS,
    },
  }
  const docs = (req.docs ?? []).slice(0, MAX_OPTIONS)
  if (docs.length >= 1) {
    const criteria: Record<string, string | null> = {}
    for (const d of docs) criteria[`doc:${d.id}`] = d.author ? `${d.title} — ${d.author}` : d.title
    criteria['none'] = 'None of these documents is the one the reader means, or the reader did not name a document.'
    questions.doc = {
      type: 'choice',
      instructions: 'If the reader asked to open a document, which of these did they mean? Titles may be referred to loosely: by author, by a word from the title, by topic.',
      criteria,
    }
  }
  const chapters = (req.chapters ?? []).slice(0, MAX_OPTIONS)
  if (chapters.length >= 1) {
    const criteria: Record<string, string | null> = {}
    chapters.forEach((title, i) => (criteria[`ch:${i}`] = `Chapter ${i + 1}: ${title}`))
    criteria['none'] = 'The reader did not name a chapter, or none of these matches.'
    questions.chapter = {
      type: 'choice',
      instructions: 'If the reader asked to go to a chapter, which one? "Chapter three" is the third; a title or topic may be named instead.',
      criteria,
    }
  }
  const shelves = req.shelves ?? []
  if (shelves.length >= 1) {
    const criteria: Record<string, string | null> = {}
    for (const s of shelves) criteria[`shelf:${s.id}`] = SHELF_HINTS[s.id] ?? s.label
    criteria['none'] = 'The reader did not ask to file the document anywhere.'
    questions.shelf = {
      type: 'choice',
      instructions: 'If the reader asked to file the document on a shelf, which shelf?',
      criteria,
    }
  }
  return questions
}

export function buildState(req: NavigateRequest): Record<string, unknown> {
  return {
    transcript: req.text,
    transcript_status: req.partial
      ? 'partial: the reader is still speaking and this may be cut off mid-sentence'
      : 'final: the reader has finished speaking',
    screen: req.screen === 'library' ? 'the library, no document open' : 'reading a document',
    open_document: req.open ? { title: req.open.title, chapter: req.open.chapter ?? undefined } : undefined,
  }
}

/** Ask the decider. Null when no decider is configured — the client goes to the conversation as before. */
export async function navigate(req: NavigateRequest, decider: Decider | null = providers().decider): Promise<NavigateDecision | null> {
  if (!decider) return null
  const text = req.text.trim()
  if (!text) return null
  const questions = buildQuestions({ ...req, text })
  const answers = await decider.decide(buildState({ ...req, text }), questions)

  const intent = answers.intent
  if (intent.type !== 'choice') throw new Error('The decider answered the intent with the wrong type')
  const out: NavigateDecision = { intent: intent.choice as Intent, confidence: intent.confidence, model: decider.name }

  const pick = (name: string, prefix: string) => {
    const a = answers[name]
    if (!a || a.type !== 'choice' || !a.choice.startsWith(prefix)) return null
    return { value: a.choice.slice(prefix.length), confidence: a.confidence }
  }
  const doc = pick('doc', 'doc:')
  if (doc) out.doc = { id: doc.value, confidence: doc.confidence }
  const chapter = pick('chapter', 'ch:')
  if (chapter) out.chapter = { index: Number(chapter.value), confidence: chapter.confidence }
  const shelf = pick('shelf', 'shelf:')
  if (shelf) out.shelf = { id: shelf.value, confidence: shelf.confidence }
  return out
}
