import { useMemo, type ReactNode } from 'react'
import { VoiceBeam } from 'voice-glow'
import { useStore } from '../store'
import { readLevels } from '../lib/audio-levels'

const SPEECH_FLOOR = 0.08 // below this the mic is just room noise (same floor as the indicator)
const SPEECH_CEIL = 0.6 // a raised voice on a laptop mic reads about here

/**
 * The glow along the bottom of the screen: it rises with the voice, gathers
 * into a travelling beam while the agent is thinking, and breathes faintly in
 * between. It is fed from the app's own meters rather than the package's
 * microphone hook — a second capture of the mic lets Chrome renegotiate the
 * processing chain and quietly drop echo cancellation (see audio-levels.ts),
 * and the narration's level comes from the output analyser, not a mic.
 *
 * The level is a getter sampled per frame by the beam's own animation loop, so
 * nothing here re-renders while someone talks.
 */
export function VoiceGlow({ children }: { children: ReactNode }) {
  const thinking = useStore((s) => s.agentState === 'thinking')
  const agentTalking = useStore((s) => s.agentState === 'speaking' || s.agentState === 'reading' || s.playing)

  const level = useMemo(() => {
    const bars = new Float32Array(8)
    return () => {
      const { agentState, micEnabled, micMuted, playing } = useStore.getState()
      // the user interrupting outranks the agent — that's the whole point
      if (micEnabled && !micMuted) {
        const mic = readLevels('mic', bars)
        if (mic > SPEECH_FLOOR) return Math.min(1, (mic - SPEECH_FLOOR) / (SPEECH_CEIL - SPEECH_FLOOR))
      }
      if (agentState === 'speaking' || agentState === 'reading' || playing) {
        // the narration is levelled already; keep it a notch under a live voice
        return Math.min(1, readLevels('output', bars) * 1.1) * 0.7
      }
      return 0
    }
  }, [])

  return (
    <VoiceBeam
      type="mobile"
      theme="auto"
      className="voice-glow"
      level={level}
      processing={thinking}
      colorVariant={agentTalking ? 'ocean' : 'colorful'}
      threshold={0.02}
      idle={0.16}
    >
      {children}
    </VoiceBeam>
  )
}
