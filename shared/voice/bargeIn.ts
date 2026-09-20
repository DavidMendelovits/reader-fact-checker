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

  /** The user is audibly talking: duck the narration now. */
  onHold: () => void = () => {}
  /** It was a cough. Resume from the paragraph the hold parked on. */
  onRelease: () => void = () => {}

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

  /** How long the current hold has been parked, for the __DEV__ overlay. */
  get heldFor(): number {
    return this._held ? this.now() - this.heldAt : 0
  }

  /** One normalized 0..1 mic level report, with whether narration is playing. */
  level(v: number, playing: boolean): void {
    const loud = v >= this.floor

    if (!this._held) {
      // Only narration can be barged in on, and only a run of loud reports counts:
      // one is a door closing.
      this.loud = playing && loud ? this.loud + 1 : 0
      if (this.loud >= this.reportsToFire) {
        this.loud = 0
        this._held = true
        this.heldAt = this.now()
        this.sawWords = false
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
    if (this._held) {
      this._held = false
      this.onRelease()
    }
  }

  private arm() {
    this.disarm()
    this.timer = this.setTimer(() => {
      this.timer = null
      if (!this._held || this.sawWords) return
      this._held = false
      this.onRelease()
    }, this.silenceMs)
  }

  private disarm() {
    if (this.timer !== null) this.clearTimer(this.timer)
    this.timer = null
  }
}
