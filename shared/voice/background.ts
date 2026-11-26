// Results that finish in the background (a fact check, later other jobs) and
// have to be said out loud without talking over the book or the agent.
//
// One line at a time, in the order they finished:
// - the book is playing: the player says it at the next paragraph break, with a
//   short cue first, then carries on reading (deps.interject)
// - nothing is playing and the agent is quiet: say it now (deps.speak)
// - the agent is listening, thinking or talking: wait until it is done
//
// A line the player could not say (the user talked over it, or the range ended
// first) goes back to the front of the queue and is tried again.
//
// Platform-free like agent.ts: no imports, so it runs under node and in Metro.

import type { AgentState } from './agent'

export interface AnnouncerDeps {
  agentState(): AgentState
  /**
   * Say a line at the next paragraph break of the narration that is playing.
   * Resolves true once it has been said, false if it never was: no narration,
   * the range ended first, or the user talked over it.
   */
  interject(text: string, cue?: () => void): Promise<boolean>
  /** Say a line now. Only called while nothing is playing and the agent is idle. */
  speak(text: string): Promise<void>
  /** A short sound before the line, so it doesn't arrive out of nowhere. */
  cue?(): void
  setTimeout(fn: () => void, ms: number): unknown
}

/** How often a busy agent is looked at again. */
export const RECHECK_MS = 200

export interface Announcer {
  /** Resolves once the line has been said. */
  announce(text: string): Promise<void>
  /** Lines waiting to be said. */
  readonly pending: number
  /** Drop everything waiting: a new document is a new conversation. */
  clear(): void
}

export function createAnnouncer(deps: AnnouncerDeps): Announcer {
  const queue: { text: string; done: () => void }[] = []
  let pumping = false
  let generation = 0

  const wait = (ms: number) => new Promise<void>((r) => { deps.setTimeout(r, ms) })

  async function pump() {
    if (pumping) return
    pumping = true
    const gen = generation
    try {
      while (queue.length > 0 && gen === generation) {
        const item = queue[0]
        const state = deps.agentState()
        let said = false
        if (state === 'reading') {
          said = await deps.interject(item.text, deps.cue)
        } else if (state === 'idle') {
          deps.cue?.()
          await deps.speak(item.text)
          said = true
        }
        if (gen !== generation) return
        if (said) {
          queue.shift()
          item.done()
        } else {
          // ponytail: polls the agent state; an event from the loop would be tidier.
          // Revisit if the 200ms shows up as a lag before a verdict.
          await wait(RECHECK_MS)
        }
      }
    } finally {
      // a clear() mid-pump already handed the queue to a fresh pump
      if (gen === generation) pumping = false
    }
  }

  return {
    announce(text) {
      return new Promise<void>((done) => {
        queue.push({ text, done })
        void pump()
      })
    },
    get pending() {
      return queue.length
    },
    clear() {
      generation++
      queue.length = 0
      pumping = false
    },
  }
}
