// Same surface as the web player (src/lib/tts.ts). playFrom() is the contract the
// agent's read_aloud tool leans on: it resolves only when the range finishes or
// pause() cuts it off.
//
// The voice itself is pluggable. The system voice (expo-speech) is the default
// and needs nothing; the on-device Kokoro voice in kokoro.ts is the upgrade —
// the same model the web app narrates with, run locally for free.
import * as Speech from 'expo-speech'
import type { VoiceEngine } from './ports'

const RECENT_WINDOW_MS = 15000

/** The OS voice. Always available; sounds like an OS voice. */
export class SystemVoice implements VoiceEngine {
  speak(text: string, rate: number): Promise<'done' | 'stopped'> {
    return new Promise((resolve) => {
      Speech.speak(text, {
        rate,
        onDone: () => resolve('done'),
        onStopped: () => resolve('stopped'),
        onError: () => resolve('done'), // a bad utterance shouldn't wedge the range
      })
    })
  }

  stop() {
    void Speech.stop()
  }
}

export class Player {
  private paragraphs: string[] = []
  private rate = 1
  private generation = 0
  private recent: { text: string; at: number }[] = []
  private engine: VoiceEngine = new SystemVoice()

  /** Text currently coming out of the speaker, for echo rejection. */
  speaking = ''
  currentIndex = 0

  onParagraphChange: (i: number) => void = () => {}
  onPlayingChange: (playing: boolean) => void = () => {}

  get recentlySpoken(): string {
    const cutoff = Date.now() - RECENT_WINDOW_MS
    this.recent = this.recent.filter((r) => r.at > cutoff)
    return [...this.recent.map((r) => r.text), this.speaking].join(' ')
  }

  private remember(text: string) {
    if (text) this.recent.push({ text, at: Date.now() })
  }

  /** Swap the voice. Whatever is playing stops; the next utterance uses the new one. */
  setEngine(engine: VoiceEngine) {
    this.pause()
    this.engine = engine
  }

  setParagraphs(paragraphs: string[]) {
    this.paragraphs = paragraphs
  }

  setRate(rate: number) {
    this.rate = rate
  }

  private speakOnce(text: string): Promise<'done' | 'stopped'> {
    return this.engine.speak(text, this.rate)
  }

  async playFrom(index: number, until = Infinity): Promise<'completed' | 'stopped'> {
    this.pause() // one player; a new range replaces whatever was going
    const gen = ++this.generation
    const last = Math.min(this.paragraphs.length - 1, until)
    this.onPlayingChange(true)
    for (let i = index; i <= last; i++) {
      if (gen !== this.generation) return 'stopped'
      this.currentIndex = i
      this.onParagraphChange(i)
      this.speaking = this.paragraphs[i] ?? ''
      const outcome = await this.speakOnce(this.speaking)
      this.remember(this.speaking)
      this.speaking = ''
      if (outcome === 'stopped' || gen !== this.generation) {
        if (gen === this.generation) this.onPlayingChange(false)
        return 'stopped'
      }
      this.currentIndex = Math.min(i + 1, last)
    }
    if (gen === this.generation) this.onPlayingChange(false)
    return 'completed'
  }

  pause() {
    this.generation++
    this.remember(this.speaking)
    this.speaking = ''
    void this.engine.stop()
    this.onPlayingChange(false)
  }

  /** One-off agent reply, outside any range. */
  async speak(text: string): Promise<void> {
    this.pause()
    const gen = ++this.generation
    this.speaking = text
    await this.speakOnce(text)
    if (gen === this.generation) {
      this.remember(this.speaking)
      this.speaking = ''
    }
  }
}

