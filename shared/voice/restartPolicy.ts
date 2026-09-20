// Who is allowed to start the recognizer, and when.
//
// Both platforms tear recognition down on their own schedule (Chrome every
// minute or so, iOS after silence) and both listeners respawned on a bare timer.
// That loses to every race: a stop() while the restart is pending respawns a
// listener nobody asked for, a start() during the async permission prompt spawns
// twice, and an `end` from the generation before a stop schedules a restart for a
// session that is over. A generation token settles all three.
//
// Pure: timers injected, so the check runs on a fake clock.

// ponytail: `any` for the timer handle — see bargeIn.ts.
type TimerHandle = any

export type RestartDeps = {
  setTimeout: (fn: () => void, ms: number) => TimerHandle
  clearTimeout: (handle: TimerHandle) => void
  /** Respawn delay after a routine `end`. 0: anything said in the gap is lost. */
  delayMs?: number
}

export class RestartPolicy {
  private gen = 0
  private running = false
  private starting = false
  private timer: TimerHandle = null
  private setTimer: (fn: () => void, ms: number) => TimerHandle
  private clearTimer: (handle: TimerHandle) => void
  private delayMs: number
  private spawn: (gen: number) => void

  constructor(deps: RestartDeps, spawn: (gen: number) => void) {
    this.setTimer = deps.setTimeout
    this.clearTimer = deps.clearTimeout
    this.delayMs = deps.delayMs ?? 0
    this.spawn = spawn
  }

  /**
   * Enable, and spawn once. Returns the current generation — hand it back to
   * started() and ended(). A second start while running or mid-start is refused
   * (the starting lock covers the async gap while permissions are prompted).
   */
  start(): number {
    if (this.running || this.starting) return this.gen
    this.running = true
    this.starting = true
    this.clearPending()
    this.spawn(this.gen)
    return this.gen
  }

  /** The recognizer reported it is up; the start lock lifts. */
  started(gen: number): void {
    if (gen === this.gen) this.starting = false
  }

  /**
   * Disable. Bumps the generation so every in-flight callback goes stale, and
   * drops a pending restart. Returns the new generation.
   */
  stop(): number {
    this.running = false
    this.starting = false
    this.clearPending()
    return ++this.gen
  }

  /** The recognizer ended. Schedules exactly one restart, if this session is still it. */
  ended(gen: number): void {
    if (!this.shouldSpawn(gen)) return
    this.starting = false
    this.clearPending()
    this.timer = this.setTimer(() => {
      this.timer = null
      if (!this.shouldSpawn(gen)) return
      this.starting = true
      this.spawn(gen)
    }, this.delayMs)
  }

  /** False once stop() has bumped past `gen`, or while disabled. */
  shouldSpawn(gen: number): boolean {
    return this.running && gen === this.gen
  }

  private clearPending() {
    if (this.timer !== null) this.clearTimer(this.timer)
    this.timer = null
  }
}
