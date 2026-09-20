// Ports for the native app, in the app's own terms. providers.ts picks the
// implementations; the player, the agent, and the screens only ever see these.
import type { LibraryDoc, Location, RemoteHighlight } from './types'

/** Speak one utterance to completion, or report that stop() cut it off. */
export interface VoiceEngine {
  /**
   * `onStart` fires when audio actually begins. The player arms a watchdog on it
   * (a "keep going" that is acknowledged and then silent is the failure it
   * catches), so an engine that can't report a start must leave `reportsStart`
   * false or every utterance is retried for nothing.
   */
  speak(text: string, rate: number, opts?: { onStart?: () => void }): Promise<'done' | 'stopped'>
  stop(): void | Promise<void>
  /** True when speak() calls its `onStart`. Absent means "taken on trust". */
  readonly reportsStart?: boolean
}

/**
 * Continuous speech input with no wake word. Same contract as the web ear
 * (src/lib/ports.ts): the app wires the handlers and reports what is playing so
 * the ear can throw away its own echo.
 */
export interface Transcriber {
  start(): Promise<void>
  stop(): void
  /** Narration state, for the level-gated barge-in: only playback can be barged in on. */
  setPlaying(playing: boolean): void
  onUtterance: (text: string) => void
  onInterim: (text: string) => void
  /** The user is audibly talking: duck the narration now, before any transcript. */
  onSpeechStart: () => void
  /** It was a cough — no words followed the hold. Resume where the hold parked. */
  onFalseStart: () => void
  onError: (msg: string) => void
  getRecentSpokenText: () => string
}

export interface Page<T> {
  items: T[]
  nextCursor: string | null
}

/**
 * The reading library: where documents and highlights live and sync to. Today
 * that is Readwise Reader (readwise.ts). The app never sees a Reader URL or a
 * Reader field name outside that adapter.
 */
export interface Library {
  /** One page of documents in a location, newest first. `updatedAfter` narrows to changes. */
  listDocuments(opts: { location: Location; updatedAfter?: string; cursor?: string }): Promise<Page<LibraryDoc>>
  /** A document's full HTML, for reading. Null when the library has no text for it (a PDF, say). */
  fetchHtml(id: string): Promise<{ doc: LibraryDoc; html: string | null }>
  /** File a document: inbox, later, archive. */
  move(id: string, location: Location): Promise<void>
  /** One page of highlights across the library. `updatedAfter` narrows to changes. */
  listHighlights(opts: { updatedAfter?: string; cursor?: string }): Promise<Page<RemoteHighlight>>
  /** Record a highlight on a document. Resolves with its id in the library. */
  createHighlight(input: { doc: LibraryDoc; text: string; note?: string }): Promise<{ remoteId: string }>
  deleteHighlight(remoteId: string): Promise<void>
}

/** The phone's local storage, as the two functions the app uses. */
export interface KeyValueStore {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  remove(key: string): Promise<void>
}
