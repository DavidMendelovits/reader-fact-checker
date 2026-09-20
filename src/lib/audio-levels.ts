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
let micStream: Promise<MediaStream> | null = null
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

/**
 * The one microphone capture in the app — recognition and the level meter share it.
 * Two concurrent getUserMedia captures of the same device let Chrome reconfigure
 * the processing chain between them, and quietly losing echo cancellation is
 * exactly what makes talking over the narration impossible on speakers.
 *
 * Echo cancellation needs the far-end reference, so this only works because the
 * narration is rendered by the same page: the browser knows what it is playing and
 * subtracts it. It degrades on Bluetooth, where the output latency moves around too
 * much for the canceller to track.
 */
export function getMicStream(): Promise<MediaStream> {
  if (!micStream) {
    micStream = navigator.mediaDevices
      .getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
      .catch((e) => {
        micStream = null // let the next attempt re-prompt
        throw e
      })
  }
  return micStream
}

export async function startMicMeter(): Promise<void> {
  if (mic) return
  try {
    const c = context()
    await c.resume()
    const stream = await getMicStream()
    mic = makeAnalyser(c)
    c.createMediaStreamSource(stream).connect(mic)
  } catch (e) {
    console.warn('mic meter unavailable', e)
  }
}

/** Releases the shared capture — callers must stop using the mic first. */
export function stopMicMeter(): void {
  const releasing = micStream
  micStream = null
  mic = null
  void releasing?.then((s) => s.getTracks().forEach((t) => t.stop())).catch(() => {})
}

/**
 * Above this, readLevels('mic') is a voice rather than the room. The barge-in gate
 * and the aurora both decide "the user has the floor" on it, so it lives with the
 * meter that produces the number rather than in each of them. Tuning it takes a
 * real speaker at full volume; a hold that turns out to be nothing costs a 1.5s
 * silence and resumes on its own.
 */
export const SPEECH_FLOOR = 0.08

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
