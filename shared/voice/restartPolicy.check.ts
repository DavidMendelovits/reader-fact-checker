// Self-check for the recognizer restart token. Run it with:
//
//   node --experimental-strip-types shared/voice/restartPolicy.check.ts
//
// Every case below is a listener that came back from the dead: a recognizer
// running after the mic was turned off, two recognizers fighting over the same
// audio session, a restart scheduled by a session that had already ended.
import assert from 'node:assert/strict'
import { RestartPolicy } from './restartPolicy.ts'

function harness(delayMs = 0) {
  let now = 0
  let seq = 0
  const pending = new Map<number, { at: number; fn: () => void }>()
  const spawns: number[] = []
  const policy = new RestartPolicy(
    {
      setTimeout: (fn: () => void, ms: number) => {
        const id = ++seq
        pending.set(id, { at: now + ms, fn })
        return id
      },
      clearTimeout: (id: number) => {
        pending.delete(id)
      },
      delayMs,
    },
    (gen: number) => spawns.push(gen),
  )
  const advance = (ms: number) => {
    const until = now + ms
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | null = null
      for (const e of pending) if (e[1].at <= until && (!next || e[1].at < next[1].at)) next = e
      if (!next) break
      pending.delete(next[0])
      now = next[1].at
      next[1].fn()
    }
    now = until
  }
  return { policy, spawns, advance }
}

// stop() during a pending restart: nothing respawns
{
  const { policy, spawns, advance } = harness(250)
  const gen = policy.start()
  policy.started(gen)
  assert.deepEqual(spawns, [gen])
  policy.ended(gen)
  policy.stop()
  advance(5000)
  assert.deepEqual(spawns, [gen], 'respawned a listener the user had turned off')
}

// a double start spawns once — the second is refused while the first is in flight
{
  const { policy, spawns } = harness()
  policy.start()
  policy.start()
  policy.start()
  assert.equal(spawns.length, 1, 'two recognizers on one audio session')
}

// end while enabled respawns exactly once, however many ends arrive
{
  const { policy, spawns, advance } = harness(250)
  const gen = policy.start()
  policy.started(gen)
  policy.ended(gen)
  policy.ended(gen)
  advance(250)
  assert.deepEqual(spawns, [gen, gen], 'an end storm spawned more than one listener')
  // and the respawned listener can end again and come back
  policy.started(gen)
  policy.ended(gen)
  advance(250)
  assert.equal(spawns.length, 3)
}

// a stale generation's end does nothing, even while a new session is running
{
  const { policy, spawns, advance } = harness(250)
  const first = policy.start()
  policy.started(first)
  policy.stop()
  const second = policy.start()
  policy.started(second)
  assert.notEqual(first, second)
  assert.deepEqual(spawns, [first, second])
  policy.ended(first)
  advance(5000)
  assert.deepEqual(spawns, [first, second], 'a dead session restarted the recognizer')
  assert.equal(policy.shouldSpawn(first), false)
  assert.equal(policy.shouldSpawn(second), true)
}

// nothing spawns while disabled
{
  const { policy, spawns, advance } = harness()
  const gen = policy.start()
  policy.stop()
  policy.ended(gen)
  advance(1000)
  assert.deepEqual(spawns, [gen])
  assert.equal(policy.shouldSpawn(gen), false)
}

// stop() then start() is a clean restart: a fresh generation, one spawn
{
  const { policy, spawns } = harness()
  const gen = policy.start()
  policy.stop()
  const again = policy.start()
  assert.deepEqual(spawns, [gen, again])
  assert.equal(policy.shouldSpawn(again), true)
}

console.log('restartPolicy: ok')
