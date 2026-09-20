// Self-check for the barge-in hold. Run it with:
//
//   node --experimental-strip-types shared/voice/holdGate.check.ts
//
// The bug this pins down: a hold that never resolves. The player parks at its
// 'stopped' branch waiting on wait(), so anything that fails to settle the gate —
// a second hold swallowing the release, a release arriving before the wait, an
// engine that never reports 'stopped' — stops the book forever with no error.
import assert from 'node:assert/strict'
import { HoldGate, withStopTimeout } from './holdGate.ts'

// hold -> release resumes the same paragraph
{
  const gate = new HoldGate()
  gate.hold()
  assert.equal(gate.held, true)
  const parked = gate.wait()
  gate.release()
  assert.equal(await parked, 'go')
  assert.equal(gate.held, false)
}

// hold -> abandon is pause() landing while parked
{
  const gate = new HoldGate()
  gate.hold()
  const parked = gate.wait()
  gate.abandon()
  assert.equal(await parked, 'abandon')
  assert.equal(gate.held, false)
}

// release without a hold is a no-op, and waiting when nothing is held goes
// straight through — the player awaits unconditionally at 'stopped'
{
  const gate = new HoldGate()
  gate.release()
  assert.equal(gate.held, false)
  assert.equal(await gate.wait(), 'go')
  gate.abandon()
  assert.equal(gate.held, false)
}

// a double hold does not need a double release: one release settles the wait
{
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
}

// every parked waiter settles, not just the first
{
  const gate = new HoldGate()
  gate.hold()
  const both = Promise.all([gate.wait(), gate.wait()])
  gate.release()
  assert.deepEqual(await both, ['go', 'go'])
}

// ---- withStopTimeout ----

// the engine reports in time: its own answer wins
assert.equal(await withStopTimeout(Promise.resolve('stopped' as const), 300, 'done' as const), 'stopped')

// the engine never reports: the fallback lands instead of wedging the book
{
  const never = new Promise<'stopped'>(() => {})
  const started = Date.now()
  assert.equal(await withStopTimeout(never, 20, 'stopped' as const), 'stopped')
  assert.ok(Date.now() - started >= 15, 'fell back before the timeout elapsed')
}

// a rejecting engine is a silent engine
assert.equal(await withStopTimeout(Promise.reject(new Error('engine gone')), 20, 'stopped' as const), 'stopped')

console.log('holdGate: ok')
