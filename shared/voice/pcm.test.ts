// The mic's float capture as 16 kHz 16-bit frames (pcm.ts): the rate is right
// whatever the input rate and however it is chunked, loud samples clip rather
// than wrap, and frames come out whole.
import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { Framer, Resampler, toInt16 } from './pcm.ts'

const ramp = (n: number) => Float32Array.from({ length: n }, (_, i) => i)

describe('Resampler', () => {
  it('turns 48 kHz into 16 kHz by averaging each group of three', () => {
    const out = new Resampler(48_000, 16_000).push(ramp(9))
    assert.deepEqual(Array.from(out), [1, 4, 7])
  })

  it('gives the same stream however the input is chunked, at an uneven ratio', () => {
    const input = ramp(4410)
    const whole = new Resampler(44_100, 16_000).push(input)
    const r = new Resampler(44_100, 16_000)
    const parts: number[] = []
    for (let i = 0; i < input.length; i += 128) parts.push(...r.push(input.subarray(i, i + 128)))
    assert.equal(whole.length, 1600)
    assert.equal(parts.length, whole.length)
    parts.forEach((v, i) => assert.ok(Math.abs(v - whole[i]) < 1e-3, `sample ${i}`))
  })

  it('makes 80ms of output from 80ms of input', () => {
    const r = new Resampler(48_000, 16_000)
    let total = 0
    for (let i = 0; i < 30; i++) total += r.push(new Float32Array(128)).length
    assert.equal(total, 1280) // 3840 input samples is 80ms at 48 kHz
  })
})

describe('toInt16', () => {
  it('maps the full range and clips past it', () => {
    assert.deepEqual(Array.from(toInt16(Float32Array.from([0, 1, -1, 2, -2, 0.5]))), [0, 32767, -32768, 32767, -32768, 16383])
  })
})

describe('Framer', () => {
  it('emits whole frames only and carries the rest', () => {
    const frames: Int16Array[] = []
    const f = new Framer(4)
    f.push(Int16Array.from([1, 2, 3]), (b) => frames.push(new Int16Array(b)))
    assert.equal(frames.length, 0)
    f.push(Int16Array.from([4, 5, 6, 7, 8, 9]), (b) => frames.push(new Int16Array(b)))
    assert.deepEqual(frames.map((x) => Array.from(x)), [[1, 2, 3, 4], [5, 6, 7, 8]])
    assert.equal(frames[0].byteLength, 8)
  })
})
