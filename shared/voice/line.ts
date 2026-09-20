// The Composer's one line of text, for both surfaces.
//
// Status used to be told three ways — a pill, an italic line in the chat panel and
// the Play button — and they disagreed ("reading" on the pill, "starting the
// audio…" in the chat). One function, one strict priority, one string. Anything
// that wants to know what the app is doing reads this.

export type LineState = {
  /** In-progress transcript. Wins over everything: it is the user's own words. */
  interim: string
  agentState: 'idle' | 'listening' | 'thinking' | 'speaking' | 'reading'
  playing: boolean
  lastAgentLine: string | null
  lastAgentLineAt: number | null
  now: number
  /** Zero-based paragraph index; the line shows it one-based. */
  current: number
  total: number
  micState: 'notAsked' | 'live' | 'muted' | 'denied' | 'off'
}

/** How long the agent's reply stays up after it stops speaking. */
const REPLY_HOLD_MS = 3000

export function lineFor(s: LineState): { text: string; italic: boolean } {
  const interim = s.interim.trim()
  if (interim) return { text: interim, italic: true }
  if (s.agentState === 'listening') return { text: 'Listening', italic: false }
  if (s.agentState === 'thinking') return { text: 'Thinking…', italic: false }

  // The reply stays readable for a beat after the voice stops, so a one-line
  // answer is not gone before you look down.
  const held =
    s.lastAgentLineAt !== null && s.now - s.lastAgentLineAt <= REPLY_HOLD_MS
  if (s.lastAgentLine && (s.agentState === 'speaking' || held)) {
    return { text: s.lastAgentLine, italic: false }
  }

  if (s.playing) return { text: `Reading ¶${s.current + 1}/${s.total}`, italic: false }

  // Idle. The last thing the agent said is better company than a hint.
  if (s.lastAgentLine) return { text: s.lastAgentLine, italic: false }
  if (s.micState === 'notAsked') return { text: 'Tap the mic to talk to it', italic: false }
  if (s.micState === 'denied') return { text: 'Mic is off in Settings', italic: false }
  return { text: 'Say something, or tap ⌨', italic: false }
}
