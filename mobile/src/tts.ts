// Same surface as the web player (src/lib/tts.ts), implemented on expo-speech.
// playFrom() is the contract the agent's read_aloud tool leans on: it resolves
// only when the range finishes or pause() cuts it off.
import * as Speech from 'expo-speech'

const RECENT_WINDOW_MS = 15000

class Tts {
  private paragraphs: string[] = []
  private rate = 1
  private generation = 0
  private recent: { text: string; at: number }[] = []

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

  setParagraphs(paragraphs: string[]) {
    this.paragraphs = paragraphs
  }

  setRate(rate: number) {
    this.rate = rate
  }

  /** Speak one utterance to completion, resolving 'stopped' if Speech.stop() cut it. */
  private speakOnce(text: string): Promise<'done' | 'stopped'> {
    return new Promise((resolve) => {
      Speech.speak(text, {
        rate: this.rate,
        onDone: () => resolve('done'),
        onStopped: () => resolve('stopped'),
        onError: () => resolve('done'), // a bad utterance shouldn't wedge the range
      })
    })
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
    void Speech.stop()
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

export const tts = new Tts()
