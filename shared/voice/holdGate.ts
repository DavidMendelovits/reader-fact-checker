// Barge-in policy without a player. The two players have nothing in common —
// web src/lib/tts.ts is a MediaSource streaming queue, mobile/src/tts.ts wraps
// expo-speech — so the shared piece is the decision, not the class. Each player
// keeps its own loop and calls this at its 'stopped' branch.
//
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
// paragraph; abandon() is pause() arriving while parked.

type Settle = (outcome: 'go' | 'abandon') => void

export class HoldGate {
  private _held = false
  private waiting: Settle[] = []

  get held(): boolean {
    return this._held
  }

  /** Idempotent: a second hold while held changes nothing. */
  hold(): void {
    this._held = true
  }

  /** Resume the paragraph. No-op when nothing is held. */
  release(): void {
    this.settle('go')
  }

  /** The hold became a real interruption. No-op when nothing is held. */
  abandon(): void {
    this.settle('abandon')
  }

  /**
   * Park until release() or abandon(). Resolves 'go' immediately when nothing is
   * held, so the caller can await unconditionally at its 'stopped' branch.
   */
  wait(): Promise<'go' | 'abandon'> {
    if (!this._held) return Promise.resolve('go')
    return new Promise<'go' | 'abandon'>((resolve) => {
      this.waiting.push(resolve)
    })
  }

  private settle(outcome: 'go' | 'abandon') {
    if (!this._held) return
    this._held = false
    const parked = this.waiting
    this.waiting = []
    for (const resolve of parked) resolve(outcome)
  }
}

/**
 * The guard for "the engine never reported stopped". Both engines promise to
 * resolve speak() with 'stopped' after a stop(); neither always does (expo-speech
 * drops onStopped if the utterance had already finished, MediaSource can end
 * mid-teardown), and a hold that waits on that promise forever wedges the book.
 *
 * ponytail: a timeout, not a state machine. 300ms is well past any real stop and
 * well under a user noticing.
 */
export function withStopTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false
    const done = (value: T) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => done(fallback), ms)
    p.then(done, () => done(fallback))
  })
}
