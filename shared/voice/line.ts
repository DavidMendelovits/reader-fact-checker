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
  micState: 'notAsked' | 'live' | 'muted' | 'denied' | 'off' | 'restarting'
  /**
   * The on-device voice is still loading at boot (mobile only; ≤2s, and Play
   * works on the system voice meanwhile). Absent is the same as false.
   */
  voiceLoading?: boolean
}

/** How long the agent's reply stays up after it stops speaking. */
export const REPLY_HOLD_MS = 3000

/** What the screen reader calls the mic button, in either app. */
export const MIC_LABEL: Record<LineState['micState'], string> = {
  notAsked: 'Microphone, off',
  live: 'Microphone, on',
  muted: 'Microphone, muted',
  denied: 'Microphone, blocked',
  off: 'Microphone, off',
  restarting: 'Microphone restarted, tap to retry',
}

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

  // Idle. The reply has had its beat (the hold above); leaving it up forever made
  // the bar a gravestone for the last thing said. The hint takes over instead.
  if (s.micState === 'notAsked') return { text: 'Tap the mic to talk to it', italic: false }
  if (s.micState === 'denied') return { text: 'Mic is off in Settings', italic: false }
  // The recognizer died three times in thirty seconds and the ear is off; the mic
  // button is amber next to this, and the tap that fixes it is on that button.
  if (s.micState === 'restarting') return { text: 'Mic restarted. Tap to retry.', italic: false }
  // Lowest of all, and still above the hint: it is news about the app, not advice.
  if (s.voiceLoading) return { text: 'Loading voice…', italic: false }
  return { text: 'Say something, or tap ⌨', italic: false }
}
