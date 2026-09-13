// Ports for the browser side: the two things the reader gets from outside the
// page. providers.ts picks the implementations; everything else imports the
// singletons from there and never names a vendor or a browser API.

/**
 * The ear. Continuous speech input with no wake word: whatever the user says is
 * a turn. Implementations own the mic and any echo handling; the app supplies
 * the handlers and tells the ear what is currently playing so it can ignore it.
 */
export interface Transcriber {
  /** False when this environment can't do speech input at all (the UI hides the mic). */
  readonly supported: boolean
  start(): Promise<void>
  stop(): void
  /** User-controlled mute. Recognition keeps running so unmuting is instant. */
  setUserMuted(muted: boolean): void

  /** Fires on each finalized utterance that survived echo rejection. */
  onUtterance: (text: string) => void
  /** Fires on in-progress transcripts; only safe to act on when unambiguous. */
  onInterim: (text: string) => void
  /** Fires as soon as the user is audibly talking, before any transcript. */
  onSpeechStart: () => void
  onError: (msg: string) => void
  /** Text currently playing through the speakers, for echo rejection. */
  getSpokenText: () => string
  /** That plus what played in the last few seconds; recognition finalizes late. */
  getRecentSpokenText: () => string
}

/**
 * The voice. Text in, a streamable audio response out — the player decides
 * whether to stream it through MediaSource or buffer it into a blob. Today this
 * is the server's /api/tts, which hides the vendor; an in-browser synthesizer
 * would implement the same thing and return a synthetic Response.
 */
export interface AudioSource {
  synthesize(text: string, signal?: AbortSignal): Promise<Response>
}
