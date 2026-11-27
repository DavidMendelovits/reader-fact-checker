// Tests for the barge-in hold.
//
// The bug this pins down: a hold that never resolves. The player parks at its
// 'stopped' branch waiting on wait(), so anything that fails to settle the gate —
// a second hold swallowing the release, a release arriving before the wait, an
// engine that never reports 'stopped' — stops the book forever with no error.
import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { HoldGate, withStopTimeout } from './holdGate.ts'

describe('HoldGate', () => {
  it('hold then release resumes the same paragraph', async () => {
    const gate = new HoldGate()
    gate.hold()
    assert.equal(gate.held, true)
    const parked = gate.wait()
    gate.release()
    assert.equal(await parked, 'go')
    assert.equal(gate.held, false)
  })

  it('hold then abandon is pause() landing while parked', async () => {
    const gate = new HoldGate()
    gate.hold()
    const parked = gate.wait()
    gate.abandon()
    assert.equal(await parked, 'abandon')
    assert.equal(gate.held, false)
  })

  // the player awaits unconditionally at 'stopped'
  it('release without a hold is a no-op, and waiting when nothing is held goes straight through', async () => {
    const gate = new HoldGate()
    gate.release()
    assert.equal(gate.held, false)
    assert.equal(await gate.wait(), 'go')
    gate.abandon()
    assert.equal(gate.held, false)
  })

  it('a double hold does not need a double release, and the gate is reusable afterwards', async () => {
    const gate = new HoldGate()
    gate.hold()
    gate.hold()
    const parked = gate.wait()
    gate.release()
    assert.equal(await parked, 'go')
    assert.equal(gate.held, false)
    // and the gate is reusable afterwards
    gate.hold()
    const again = gate.wait()
    gate.abandon()
    assert.equal(await again, 'abandon')
  })

  it('every parked waiter settles, not just the first', async () => {
    const gate = new HoldGate()
    gate.hold()
    const both = Promise.all([gate.wait(), gate.wait()])
    gate.release()
    assert.deepEqual(await both, ['go', 'go'])
  })
})

describe('withStopTimeout', () => {
  it('the engine reports in time: its own answer wins', async () => {
    assert.equal(await withStopTimeout(Promise.resolve('stopped' as const), 300, 'done' as const), 'stopped')
  })

  it('the engine never reports: the fallback lands instead of wedging the book', async () => {
    const never = new Promise<'stopped'>(() => {})
    const started = Date.now()
    assert.equal(await withStopTimeout(never, 20, 'stopped' as const), 'stopped')
    assert.ok(Date.now() - started >= 15, 'fell back before the timeout elapsed')
  })

  it('a rejecting engine is a silent engine', async () => {
    assert.equal(await withStopTimeout(Promise.reject(new Error('engine gone')), 20, 'stopped' as const), 'stopped')
  })
})
