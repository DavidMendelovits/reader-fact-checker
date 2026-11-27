// AsyncStorage for tests: an in-memory map, reachable from a test as globalThis.__async.
const m = new Map<string, string>()
;(globalThis as Record<string, unknown>).__async = m
export default {
  getItem: async (k: string) => m.get(k) ?? null,
  setItem: async (k: string, v: string) => void m.set(k, v),
  removeItem: async (k: string) => void m.delete(k),
}
