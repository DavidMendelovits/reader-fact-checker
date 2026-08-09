// A soft two-note blip, played the moment an utterance is handed to the model.
//
// The fast-path commands act instantly, so their answer *is* the feedback. A
// conversational turn costs a round-trip, and without this the app sits silent long
// enough that you start wondering whether it heard you. Synthesized rather than
// shipped as an asset: it's two oscillators and no bytes to load.
import { audioContext } from './audio-levels'

const GAIN = 0.05 // quiet enough to sit under narration, loud enough to notice

function note(ctx: AudioContext, freq: number, at: number, dur: number) {
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.type = 'sine'
  osc.frequency.value = freq
  // ramped rather than gated — a square-edged envelope clicks
  gain.gain.setValueAtTime(0.0001, at)
  gain.gain.exponentialRampToValueAtTime(GAIN, at + 0.012)
  gain.gain.exponentialRampToValueAtTime(0.0001, at + dur)
  osc.connect(gain).connect(ctx.destination)
  osc.start(at)
  osc.stop(at + dur + 0.02)
}

/**
 * ~150ms acknowledgment. Autoplay policy blocks an AudioContext that has never seen
 * a gesture; by the time anyone is talking to the agent the mic or the composer has
 * supplied one, and a failure here is never worth surfacing.
 */
export function blip() {
  try {
    const ctx = audioContext()
    if (ctx.state === 'suspended') void ctx.resume()
    const now = ctx.currentTime
    note(ctx, 587.33, now, 0.07) // D5
    note(ctx, 880, now + 0.08, 0.07) // A5
  } catch {
    /* no audio available — the acknowledgment is a nicety */
  }
}
