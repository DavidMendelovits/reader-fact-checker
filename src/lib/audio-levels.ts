// Real levels for the speaking indicator: one analyser on the TTS output element,
// one on a mic stream opened alongside SpeechRecognition (Chrome allows both).
//
// Routing the <audio> element through WebAudio is the risky part — if the
// AudioContext is suspended, the element goes *silent* rather than falling back to
// normal playback. So we only rewire once the context is confirmed running, and a
// failure anywhere just means no visualization.

let ctx: AudioContext | null = null
let output: AnalyserNode | null = null
let mic: AnalyserNode | null = null
let micStream: MediaStream | null = null
let scratch = new Uint8Array(0)

function context(): AudioContext {
  ctx ??= new AudioContext()
  return ctx
}

/** The one AudioContext this app opens — the earcon plays through it too. */
export const audioContext = context

function makeAnalyser(c: AudioContext): AnalyserNode {
  const a = c.createAnalyser()
  a.fftSize = 128
  a.smoothingTimeConstant = 0.75
  return a
}

export async function attachOutput(el: HTMLAudioElement): Promise<void> {
  if (output) return
  try {
    const c = context()
    await c.resume()
    if (c.state !== 'running') return // never rewire a suspended context
    const src = c.createMediaElementSource(el)
    output = makeAnalyser(c)
    src.connect(output)
    output.connect(c.destination)
  } catch (e) {
    console.warn('output meter unavailable', e)
  }
}

export async function startMicMeter(): Promise<void> {
  if (mic) return
  try {
    const c = context()
    await c.resume()
    micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true } })
    mic = makeAnalyser(c)
    c.createMediaStreamSource(micStream).connect(mic)
  } catch (e) {
    console.warn('mic meter unavailable', e)
  }
}

export function stopMicMeter(): void {
  micStream?.getTracks().forEach((t) => t.stop())
  micStream = null
  mic = null
}

/**
 * Fill `bars` with 0..1 magnitudes for the given source, averaging the FFT bins
 * down to however many bars the caller wants. Returns the peak.
 */
export function readLevels(which: 'output' | 'mic', bars: Float32Array): number {
  const node = which === 'output' ? output : mic
  if (!node) {
    bars.fill(0)
    return 0
  }
  if (scratch.length !== node.frequencyBinCount) scratch = new Uint8Array(node.frequencyBinCount)
  node.getByteFrequencyData(scratch)

  // speech energy sits low in the spectrum; ignore the sparse top half
  const usable = Math.floor(scratch.length * 0.6)
  const per = usable / bars.length
  let peak = 0
  for (let i = 0; i < bars.length; i++) {
    let sum = 0
    const from = Math.floor(i * per)
    const to = Math.max(from + 1, Math.floor((i + 1) * per))
    for (let j = from; j < to; j++) sum += scratch[j]
    const v = sum / (to - from) / 255
    bars[i] = v
    if (v > peak) peak = v
  }
  return peak
}
