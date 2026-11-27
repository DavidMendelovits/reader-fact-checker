// The keychain for tests: an in-memory map at globalThis.__secure. Set
// globalThis.__secureFails to stand in for a keychain that is not available.
const g = globalThis as Record<string, unknown>
const m = new Map<string, string>()
g.__secure = m
const check = () => {
  if (g.__secureFails) throw new Error('keychain unavailable')
}
export const getItemAsync = async (k: string) => (check(), m.get(k) ?? null)
export const setItemAsync = async (k: string, v: string) => void (check(), m.set(k, v))
export const deleteItemAsync = async (k: string) => void (check(), m.delete(k))
