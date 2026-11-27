// expo-speech for tests: records calls at globalThis.__speech, and stop() hangs
// until the test calls __speech.finishStop().
const calls: string[] = []
let resolveStop: (() => void) | null = null
const speech = {
  calls,
  opts: undefined as unknown,
  finishStop() {
    const r = resolveStop
    resolveStop = null
    if (r) r()
  },
}
;(globalThis as Record<string, unknown>).__speech = speech
export function speak(text: string, opts?: unknown) {
  calls.push('speak:' + text)
  speech.opts = opts
}
export function stop() {
  calls.push('stop')
  return new Promise<void>((r) => {
    resolveStop = r
  })
}
