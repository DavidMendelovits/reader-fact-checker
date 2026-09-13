// Ports for the native app: the ear and the voice, in the app's own terms.
// providers.ts picks the implementations; the player and the agent only ever
// see these interfaces.

/** Speak one utterance to completion, or report that stop() cut it off. */
export interface VoiceEngine {
  speak(text: string, rate: number): Promise<'done' | 'stopped'>
  stop(): void | Promise<void>
}

/**
 * Continuous speech input with no wake word. Same contract as the web ear
 * (src/lib/ports.ts): the app wires the handlers and reports what is playing so
 * the ear can throw away its own echo.
 */
export interface Transcriber {
  start(): Promise<void>
  stop(): void
  onUtterance: (text: string) => void
  onInterim: (text: string) => void
  onSpeechStart: () => void
  onError: (msg: string) => void
  getRecentSpokenText: () => string
}
