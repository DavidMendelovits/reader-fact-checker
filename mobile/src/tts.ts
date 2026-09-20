// Same surface as the web player (src/lib/tts.ts). playFrom() is the contract the
// agent's read_aloud tool leans on: it resolves only when the range finishes or
// pause() cuts it off.
//
// The voice itself is pluggable. The system voice (expo-speech) is the default
// and needs nothing; the on-device Kokoro voice in kokoro.ts is the upgrade —
// the same model the web app narrates with, run locally for free.
import * as Speech from 'expo-speech'
import type { VoiceEngine } from './ports'
// the hold policy is shared with the web player; its checks live next to it
import { HoldGate, withStopTimeout } from '../../shared/voice/holdGate.ts'

const RECENT_WINDOW_MS = 15000

/** How long a hold waits for the engine to admit it stopped (holdGate.ts). */
const STOP_TIMEOUT_MS = 300

/**
 * How long an utterance may stay silent before it is treated as a dead engine.
 * Exported so the check doesn't have to guess.
 */
export const START_TIMEOUT_MS = 1000

/** The OS voice. Always available; sounds like an OS voice. */
export class SystemVoice implements VoiceEngine {
  readonly reportsStart = true
  /**
   * The teardown of the last utterance. `Speech.stop()` is async, and an
   * utterance queued while it is still unwinding is swallowed: the agent says
   * "keep going", the range starts, and nothing comes out of the speaker. Every
   * speak() waits for the stop it follows.
   */
  private stopping: Promise<void> | null = null

  async speak(text: string, rate: number, opts?: { onStart?: () => void }): Promise<'done' | 'stopped'> {
    await this.stopping
    return new Promise((resolve) => {
      Speech.speak(text, {
        rate,
        onStart: () => opts?.onStart?.(),
        onDone: () => resolve('done'),
        onStopped: () => resolve('stopped'),
        onError: () => resolve('done'), // a bad utterance shouldn't wedge the range
      })
    })
  }

  stop(): Promise<void> {
    const stopping = Speech.stop().catch(() => {})
    this.stopping = stopping
    return stopping
  }
}

/**
 * No sound, real timing: each utterance "plays" for about as long as it would
 * take to say. For builds that can't make sound — the web smoke test, where
 * headless Chromium's speech synthesis never reports finishing.
 */
export class SilentVoice implements VoiceEngine {
  readonly reportsStart = true
  private timer: ReturnType<typeof setTimeout> | null = null
  private cancel: (() => void) | null = null
  speak(text: string, rate: number, opts?: { onStart?: () => void }): Promise<'done' | 'stopped'> {
    this.stop()
    return new Promise((resolve) => {
      opts?.onStart?.() // silence that starts on time is still a start
      this.cancel = () => resolve('stopped')
      this.timer = setTimeout(() => {
        this.cancel = null
        resolve('done')
      }, Math.min(1500, (text.length * 8) / Math.max(0.5, rate)))
    })
  }
  stop() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.cancel?.()
    this.cancel = null
  }
}

/** One utterance's outcome, plus "the engine never made a sound". */
type Attempt = 'done' | 'stopped' | 'no-start'

export class Player {
  private paragraphs: string[] = []
  private rate = 1
  private generation = 0
  private recent: { text: string; at: number }[] = []
  private engine: VoiceEngine = new SystemVoice()
  private gate = new HoldGate()
  private failure: 'no-audio' | null = null
  /** The utterance in flight, and the resolver a hold settles it through. */
  private utterance: Promise<'done' | 'stopped'> | null = null
  private settleUtterance: ((outcome: Attempt) => void) | null = null

  /** Text currently coming out of the speaker, for echo rejection. */
  speaking = ''
  currentIndex = 0

  onParagraphChange: (i: number) => void = () => {}
  onPlayingChange: (playing: boolean) => void = () => {}

  /** Parked mid-range by hold(): the book is silent but the range is still live. */
  get held(): boolean {
    return this.gate.held
  }

  /** Set when two attempts at one utterance produced no audio; cleared on the next start. */
  get lastFailure(): 'no-audio' | null {
    return this.failure
  }

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

  /**
   * One utterance, with the start watchdog. 'no-start' means the engine took the
   * text and made no sound; hold() settles it as 'stopped' through settleUtterance.
   */
  private attempt(text: string): Promise<Attempt> {
    return new Promise<Attempt>((resolve) => {
      let settled = false
      const finish = (outcome: Attempt) => {
        if (settled) return
        settled = true
        if (timer !== null) clearTimeout(timer)
        this.settleUtterance = null
        resolve(outcome)
      }
      // Only an engine that reports starts can be watched; the rest are trusted.
      const timer = this.engine.reportsStart ? setTimeout(() => finish('no-start'), START_TIMEOUT_MS) : null
      this.settleUtterance = finish
      const spoken = this.engine.speak(text, this.rate, {
        onStart: () => {
          this.failure = null
          if (timer !== null) clearTimeout(timer)
        },
      })
      this.utterance = spoken
      spoken.then(finish, () => finish('done'))
    })
  }

  private async speakOnce(text: string): Promise<'done' | 'stopped'> {
    const first = await this.attempt(text)
    if (first !== 'no-start') return first
    // Nothing came out of the speaker. One retry — the usual cause is an engine
    // still unwinding a stop — then say so rather than racing through the book
    // in silence.
    await this.engine.stop()
    const second = await this.attempt(text)
    if (second !== 'no-start') return second
    this.failure = 'no-audio'
    return 'done'
  }

  //   playFrom loop, one paragraph:
  //
  //     speak(¶i) ──> 'done' ─────────────────────────────> next ¶
  //         │
  //         └──────> 'stopped' ──┬── gate.held? no ──────> return 'stopped'
  //                              │
  //                              └── gate.held? yes
  //                                     │
  //                                await gate.wait()
  //                                     │
  //                          ┌──────────┴──────────┐
  //                       'go'                 'abandon'
  //                          │                      │
  //                  re-speak the SAME ¶i    return 'stopped'
  //                  (generation untouched,   (pause() — the real
  //                   so read_aloud is         interruption)
  //                   still waiting)
  //
  // hold() stops the engine and leaves the loop parked; release() resumes the same
  // paragraph; pause() is a hold arriving as a real interruption.
  async playFrom(index: number, until = Infinity): Promise<'completed' | 'stopped'> {
    this.pause() // one player; a new range replaces whatever was going
    const gen = ++this.generation
    const last = Math.min(this.paragraphs.length - 1, until)
    this.onPlayingChange(true)
    for (let i = index; i <= last; i++) {
      if (gen !== this.generation) return 'stopped'
      // The one park site: reached either from the 'stopped' branch below or from
      // a hold that landed in the gap between two paragraphs.
      if (this.gate.held) {
        const resume = await this.gate.wait()
        if (gen !== this.generation || resume === 'abandon') return 'stopped'
      }
      this.currentIndex = i
      this.onParagraphChange(i)
      this.speaking = this.paragraphs[i] ?? ''
      const outcome = await this.speakOnce(this.speaking)
      this.remember(this.speaking)
      this.speaking = ''
      if (gen !== this.generation) return 'stopped'
      if (outcome === 'stopped') {
        if (!this.gate.held) {
          this.onPlayingChange(false)
          return 'stopped'
        }
        i -= 1 // release re-speaks this paragraph from its start
        continue
      }
      this.currentIndex = Math.min(i + 1, last)
    }
    if (gen === this.generation) this.onPlayingChange(false)
    return 'completed'
  }

  /**
   * Duck the narration without ending the range: the generation is untouched, so
   * the agent's read_aloud is still waiting and release() picks the paragraph up
   * from its start. A hold while a one-off speak() is playing just stops it.
   */
  hold() {
    if (this.gate.held) return
    this.gate.hold()
    this.stopEngine()
    // `playing` deliberately stays true: the range is still live, the row tint has
    // not moved, and a cough must cost nothing. `held` is the separate signal.
  }

  /**
   * Stop the engine and make sure the utterance admits it. Every engine promises
   * a 'stopped' after stop() and none of them always keeps it (holdGate.ts); an
   * unsettled utterance leaves the loop awaiting forever, which wedges the hold
   * and, through pause(), the agent turn waiting on read_aloud.
   */
  private stopEngine() {
    const inflight = this.utterance
    const settle = this.settleUtterance
    void this.engine.stop()
    if (inflight && settle) void withStopTimeout<Attempt>(inflight, STOP_TIMEOUT_MS, 'stopped').then(settle)
  }

  /** Resume the paragraph the hold parked on. No-op if pause() got there first. */
  release() {
    this.gate.release()
  }

  pause() {
    this.generation++
    this.gate.abandon() // a parked loop unwinds as 'stopped'
    this.remember(this.speaking)
    this.speaking = ''
    this.stopEngine()
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
