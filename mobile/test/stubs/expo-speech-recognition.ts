// expo-speech-recognition for tests: the test drives events through
// globalThis.__rec.emit and reads the start/stop calls back.
type Handler = (ev?: unknown) => void
const handlers: Record<string, Handler[]> = {}
const calls: string[] = []
const rec = {
  calls,
  granted: true,
  emit(name: string, ev?: unknown) {
    for (const h of handlers[name] || []) h(ev)
  },
  reset() {
    for (const k of Object.keys(handlers)) delete handlers[k]
    calls.length = 0
    rec.granted = true
  },
  handler(name: string, i: number) {
    return (handlers[name] || [])[i]
  },
}
;(globalThis as Record<string, unknown>).__rec = rec
export const ExpoSpeechRecognitionModule = {
  addListener(name: string, fn: Handler) {
    handlers[name] = handlers[name] || []
    handlers[name].push(fn)
    return {
      remove() {
        handlers[name] = (handlers[name] || []).filter((h) => h !== fn)
      },
    }
  },
  start() {
    calls.push('start')
  },
  stop() {
    calls.push('stop')
  },
  async requestPermissionsAsync() {
    return { granted: rec.granted }
  },
}
