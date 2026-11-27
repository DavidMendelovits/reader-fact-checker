// The mic as a streaming speech-to-text vendor wants it: one channel of 16-bit
// little-endian PCM at a fixed rate, in fixed-size frames. The browser captures
// float samples at whatever rate its AudioContext runs (usually 48 kHz, 44.1 on
// some machines), so this converts and frames them.
//
// Pure, and platform-free: the phone could feed the same thing.

/**
 * Converts one rate to a lower one by averaging each output sample's span of
 * input, which doubles as the low-pass filter decimation needs. Keeps its place
 * across calls, so chunks of any size give the same stream as one big chunk.
 */
export class Resampler {
  private ratio: number
  // Positions are counted from the start of the stream, so chunking can't move a
  // boundary by rounding: output sample k always starts at input k * ratio.
  private emitted = 0
  private base = 0 // stream index of carry[0]
  private carry = new Float32Array(0)

  constructor(inRate: number, outRate: number) {
    this.ratio = inRate / outRate
  }

  push(input: Float32Array): Float32Array {
    const buf = new Float32Array(this.carry.length + input.length)
    buf.set(this.carry)
    buf.set(input, this.carry.length)
    const end = this.base + buf.length
    const out: number[] = []
    for (let k = this.emitted; (k + 1) * this.ratio <= end; k++) {
      const from = Math.floor(k * this.ratio) - this.base
      const to = Math.floor((k + 1) * this.ratio) - this.base
      if (to <= from) {
        out.push(buf[from]) // upsampling: no span to average, take the sample
      } else {
        let sum = 0
        for (let i = from; i < to; i++) sum += buf[i]
        out.push(sum / (to - from))
      }
      this.emitted = k + 1
    }
    const keep = Math.min(buf.length, Math.max(0, Math.floor(this.emitted * this.ratio) - this.base))
    this.carry = buf.slice(keep)
    this.base += keep
    return Float32Array.from(out)
  }
}

/** Float samples in -1..1 to signed 16-bit, clipping anything louder. */
export function toInt16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  return out
}

/** Collects samples and hands out whole frames of `size`, holding the remainder for the next push. */
export class Framer {
  private buf: Int16Array
  private fill = 0

  constructor(private size: number) {
    this.buf = new Int16Array(size)
  }

  push(samples: Int16Array, emit: (frame: ArrayBuffer) => void) {
    let i = 0
    while (i < samples.length) {
      const take = Math.min(this.size - this.fill, samples.length - i)
      this.buf.set(samples.subarray(i, i + take), this.fill)
      this.fill += take
      i += take
      if (this.fill === this.size) {
        emit(this.buf.slice().buffer) // Int16Array is the platform's byte order: little-endian everywhere we run
        this.fill = 0
      }
    }
  }

  reset() {
    this.fill = 0
  }
}
