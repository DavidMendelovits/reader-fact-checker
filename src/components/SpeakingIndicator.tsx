import { useEffect, useRef } from 'react'
import { useStore } from '../store'
import { readLevels } from '../lib/audio-levels'

const BARS = 27
const SPEECH_FLOOR = 0.08 // below this the mic is just room noise

/**
 * Floating waveform showing who currently has the floor. Levels are real FFT
 * magnitudes, not an animation — when the meters aren't available (WebAudio
 * blocked, mic off) the bars sit flat and the pill just reads as a status chip.
 */
export function SpeakingIndicator() {
  const agentState = useStore((s) => s.agentState)
  const micEnabled = useStore((s) => s.micEnabled)
  const micMuted = useStore((s) => s.micMuted)
  const rootRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const labelRef = useRef<HTMLSpanElement>(null)

  // One rAF loop owns the DOM here: re-rendering React at 60fps to move bars
  // would be silly, and the "who's talking" flag flickers faster than state.
  useEffect(() => {
    const canvas = canvasRef.current
    const root = rootRef.current
    const label = labelRef.current
    if (!canvas || !root || !label) return
    const ctx2d = canvas.getContext('2d')
    if (!ctx2d) return

    const dpr = window.devicePixelRatio || 1
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    canvas.width = w * dpr
    canvas.height = h * dpr
    ctx2d.scale(dpr, dpr)

    const bars = new Float32Array(BARS)
    const smoothed = new Float32Array(BARS)
    let frame = 0
    // Bar colour is a --indicator-bar swap in the stylesheet, so it themes with
    // everything else. Read it when the speaker changes rather than every frame —
    // getComputedStyle at 60fps is a layout read for a value that rarely moves.
    let lastWho = ''
    let barColor = ''

    const draw = () => {
      frame = requestAnimationFrame(draw)
      const { agentState: state, micEnabled: on, micMuted: muted, playing } = useStore.getState()
      // `playing` covers the manual Play button, which runs outside the agent loop
      const agentTalking = state === 'speaking' || state === 'reading' || playing

      // the user interrupting outranks the agent — that's the whole point
      let source: 'mic' | 'output' | null = null
      if (on && !muted && readLevels('mic', bars) > SPEECH_FLOOR) source = 'mic'
      else if (agentTalking) source = 'output'

      if (!source) {
        root.dataset.active = 'off'
        return
      }
      if (source === 'output') readLevels('output', bars)

      root.dataset.active = 'on'
      root.dataset.who = source === 'mic' ? 'user' : 'agent'
      label.textContent =
        source === 'mic' ? 'you' : state === 'speaking' ? 'speaking' : 'reading'

      const who = root.dataset.who ?? ''
      if (who !== lastWho) {
        lastWho = who
        barColor = getComputedStyle(root).getPropertyValue('--indicator-bar').trim()
      }
      ctx2d.clearRect(0, 0, w, h)
      ctx2d.fillStyle = barColor
      const slot = w / BARS
      const bw = Math.max(2, slot * 0.5)
      for (let i = 0; i < BARS; i++) {
        // ease toward the new level so bars glide instead of strobing
        smoothed[i] += (bars[i] - smoothed[i]) * 0.35
        const mag = Math.min(1, smoothed[i] * 1.6)
        const bh = Math.max(2, mag * h)
        const x = i * slot + (slot - bw) / 2
        ctx2d.beginPath()
        ctx2d.roundRect(x, (h - bh) / 2, bw, bh, bw / 2)
        ctx2d.fill()
      }
    }

    frame = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(frame)
  }, [])

  // keep the pill mounted but hidden when nothing is happening
  const playing = useStore((s) => s.playing)
  const idle = agentState === 'idle' && !playing && (!micEnabled || micMuted)

  return (
    <div ref={rootRef} className="speaking-indicator" data-active={idle ? 'off' : 'on'}>
      <canvas ref={canvasRef} width={200} height={28} />
      <span ref={labelRef} className="speaking-label" />
    </div>
  )
}
