// When to hold the narration, decided from mic level alone.
//
// The old rule was "three recognized words": the first two words of a real
// interruption played over the book, and a short one merged with leaked narration
// read as an echo and never stopped anything. Level reports arrive every 80ms, so
// two of them is ~160ms after the user starts talking — before the transcript
// exists at all. The transcript path stays as a fallback and calls words().
//
// Pure: the clock and the timer are injected, so the whole thing runs in a check
// with a fake clock and nothing to wait for.

// ponytail: `any` for the timer handle. Node, the DOM and React Native all return
// something different from setTimeout and none of them is worth a generic here.
type TimerHandle = any

export type BargeInDeps = {
  /** Normalized level at or above which the mic is hearing a voice. */
  floor?: number
  /** Consecutive reports at or above the floor before the hold fires. */
  reportsToFire?: number
  /** Sub-floor quiet, with no words, that auto-releases the hold. */
  silenceMs?: number
  now: () => number
  setTimeout: (fn: () => void, ms: number) => TimerHandle
  clearTimeout: (handle: TimerHandle) => void
}

/**
 * One barge-in, for the client meter. `path` is what stopped the narration: the
 * mic level, or the transcript when the level never fired. `ms` runs from the
 * first loud report of the run to the stop. `real` is false for a hold that no
 * words followed (a cough, a door).
 */
export type BargeIn = { path: 'level' | 'words'; ms: number; real: boolean }

/** How old the latest loud run may be for a words-path stop to be timed from it. */
const RECENT_MS = 3000

export class BargeInGate {
  private floor: number
  private reportsToFire: number
  private silenceMs: number
  private now: () => number
  private setTimer: (fn: () => void, ms: number) => TimerHandle
  private clearTimer: (handle: TimerHandle) => void

  private loud = 0 // consecutive reports at or above the floor
  private _held = false
  private sawWords = false
  private timer: TimerHandle = null
  private heldAt = 0
  private wasLoud = false // the last report, playing or not
  private runStart: number | null = null // when the current or latest loud run began
  private lastLoudAt = 0
  private playing = false
  private pending: BargeIn | null = null // a level hold not yet known to be real
  private measured = false // this utterance's barge-in has been reported

  /** The user is audibly talking: duck the narration now. */
  onHold: () => void = () => {}
  /** It was a cough. Resume from the paragraph the hold parked on. */
  onRelease: () => void = () => {}
  /** Once per barge-in, when it is known to be real or a false start (the client meter). */
  onMeasure: (m: BargeIn) => void = () => {}

  constructor(deps: BargeInDeps) {
    this.floor = deps.floor ?? 0.25
    this.reportsToFire = deps.reportsToFire ?? 2
    this.silenceMs = deps.silenceMs ?? 1500
    this.now = deps.now
    this.setTimer = deps.setTimeout
    this.clearTimer = deps.clearTimeout
  }

  get held(): boolean {
    return this._held
  }

  /** One normalized 0..1 mic level report, with whether narration is playing. */
  level(v: number, playing: boolean): void {
    const loud = v >= this.floor
    const now = this.now()
    if (loud && !this.wasLoud) this.runStart = now
    if (loud) this.lastLoudAt = now
    this.wasLoud = loud
    this.playing = playing

    if (!this._held) {
      // Only narration can be barged in on, and only a run of loud reports counts:
      // one is a door closing.
      this.loud = playing && loud ? this.loud + 1 : 0
      if (this.loud >= this.reportsToFire) {
        this.loud = 0
        this._held = true
        this.heldAt = now
        this.sawWords = false
        // a words-path stop already reported this utterance; the level catching up is the same barge-in
        this.pending = this.measured ? null : { path: 'level', ms: now - (this.runStart ?? now), real: true }
        this.onHold()
      } else {
        return
      }
    }

    if (this.sawWords) return
    // Release counts silence, not time: every loud report pushes the countdown out,
    // so a long sentence with no transcript yet stays held.
    if (loud) this.arm()
    else if (this.timer === null) this.arm()
  }

  /** An interim or a final arrived. The turn is real; the caller owns it from here. */
  words(): void {
    this.sawWords = true
    this.disarm()
    this.settle(true)
  }

  /**
   * The caller stopped the narration on words, the level never having fired (a
   * quiet voice, or one the floor missed). Timed from the latest loud run when
   * there was one in the last few seconds; otherwise there is no start to time from.
   */
  wordsHold(): void {
    if (this.measured || this._held || !this.playing) return
    const now = this.now()
    if (this.runStart === null || now - this.lastLoudAt > RECENT_MS) return
    this.measured = true
    this.onMeasure({ path: 'words', ms: now - this.runStart, real: true })
  }

  /**
   * The final was handed to the caller: the utterance is over. Forget it — without
   * this the gate stayed `sawWords` until the recognizer ended, so it fired once
   * per session and every later utterance went unheld. The hold is not released,
   * because words() already made it the caller's interruption.
   */
  utteranceDone(): void {
    this.settle(true) // a final with no interim before it is still words
    this.measured = false
    this.loud = 0
    this._held = false
    this.sawWords = false
    this.disarm()
  }

  /**
   * Recognizer end / no-speech / aborted. Clears the run counter so the next
   * speech start fires again — the old `talking` flag stuck true here and killed
   * barge-in for the rest of the session.
   *
   * A hold outliving its recognizer releases rather than stranding the book. Safe
   * to be wrong: HoldGate.release() is a no-op once the hold became a pause.
   */
  reset(): void {
    this.loud = 0
    this.sawWords = false
    this.disarm()
    this.measured = false
    if (this._held) {
      this._held = false
      this.settle(false)
      this.onRelease()
    }
    this.pending = null
  }

  private arm() {
    this.disarm()
    this.timer = this.setTimer(() => {
      this.timer = null
      if (!this._held || this.sawWords) return
      this._held = false
      this.settle(false)
      this.onRelease()
    }, this.silenceMs)
  }

  /** Report the open level hold, now that it is known to be real or not. */
  private settle(real: boolean) {
    const p = this.pending
    this.pending = null
    if (!p) return
    // a cough has no final to clear this, and the next quiet barge-in should still count
    this.measured = real
    this.onMeasure({ ...p, real })
  }

  private disarm() {
    if (this.timer !== null) this.clearTimer(this.timer)
    this.timer = null
  }
}
