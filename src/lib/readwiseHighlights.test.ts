// Web highlights to Readwise (readwiseHighlights.ts): only new highlights on a
// Reader document go; a thought with skipped words goes as tagged runs in order;
// a failure stays pending and the retry picks up where it stopped; removing a
// highlight removes what landed, now or on a later try; and a write that lands
// after the reader switched books is saved on the book it belongs to.
import { describe, expect, it, vi } from 'vitest'
import { forReadwise, HighlightSync, type SyncDeps } from './readwiseHighlights.ts'
import type { LibraryDoc } from '../../shared/library/types.ts'
import type { Doc, Highlight } from '../types'

const doc = (id: string): Doc => ({ id, title: id, source: 'x', chapters: [] })
const reader = { id: 'r1', title: 'The Long Storm', author: null, sourceUrl: null, category: 'article' } as LibraryDoc
const hl = (id: string, more: Partial<Highlight> = {}): Highlight => ({ id, anchor: 3, text: `text ${id}`, createdAt: 0, ...more })

function setup(opts: { fail?: (text: string) => boolean; removeFails?: boolean; inLibrary?: boolean } = {}) {
  type S = { doc: Doc | null; highlights: Highlight[] }
  let state: S = { doc: doc('readwise:r1'), highlights: [] }
  const listeners: ((s: S, p: S) => void)[] = []
  const set = (patch: Partial<S>) => {
    const prev = state
    state = { ...state, ...patch }
    listeners.forEach((l) => l(state, prev))
  }
  const saved = new Map<string, Highlight[]>()
  const store = new Map<string, string>()
  let n = 0
  const created: { text: string; note?: string; location: number }[] = []
  const removed: string[] = []
  const deps: SyncDeps = {
    getState: () => state,
    subscribe: (l) => void listeners.push(l),
    setHighlights: (highlights) => set({ highlights }),
    patchSaved: (id, change) => {
      if (!saved.has(id)) return false
      saved.set(id, change(saved.get(id)!))
      return true
    },
    hasToken: () => true,
    libraryDoc: (id) => (opts.inLibrary === false || id !== 'r1' ? undefined : reader),
    create: vi.fn(async (_d, h) => {
      if (opts.fail?.(h.text)) throw new Error('offline')
      created.push(h)
      return String(++n)
    }),
    remove: vi.fn(async (id) => {
      if (opts.removeFails) throw new Error('offline')
      removed.push(id)
    }),
    storage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v) },
  }
  const sync = new HighlightSync(deps).start()
  const add = (h: Highlight) => set({ highlights: [h, ...state.highlights] })
  const drop = (id: string) => set({ highlights: state.highlights.filter((h) => h.id !== id) })
  return { sync, deps, set, add, drop, created, removed, saved, opts, get state() { return state }, queue: () => JSON.parse(store.get('rfc-readwise-deletes') ?? '[]') }
}

/** Hold the next write mid-flight: `started` once it is under way, `release` to let it land. */
function hold(deps: SyncDeps) {
  let release!: () => void
  let begin!: () => void
  const gate = new Promise<void>((r) => (release = r))
  const started = new Promise<void>((r) => (begin = r))
  const create = deps.create
  deps.create = async (d, h) => {
    begin()
    await gate
    return create(d, h)
  }
  return { started, release }
}

describe('forReadwise', () => {
  it('marks a highlight only on a Reader document with a token, and keeps runs only when there are several', () => {
    const h = hl('a')
    expect(forReadwise(h, ['a'], 'readwise:r1', true)).toEqual({ ...h, pending: true, parts: undefined })
    expect(forReadwise(h, ['a', 'b'], 'readwise:r1', true).parts).toEqual(['a', 'b'])
    expect(forReadwise(h, ['a'], 'url:https://x', true)).toBe(h)
    expect(forReadwise(h, ['a'], 'readwise:r1', false)).toBe(h)
    expect(forReadwise(h, ['x'.repeat(8192)], 'readwise:r1', true)).toBe(h) // could never land
  })
})

describe('HighlightSync', () => {
  it('writes a new highlight and records its id; older unmarked ones are left alone', async () => {
    const t = setup()
    t.set({ highlights: [hl('old')] })
    t.add(hl('new', { pending: true, note: 'why' }))
    await t.sync.sync()
    expect(t.created).toEqual([{ text: 'text new', note: 'why', location: 30000 }])
    expect(t.state.highlights.find((h) => h.id === 'new')).toMatchObject({ remoteIds: ['1'], pending: undefined })
    expect(t.state.highlights.find((h) => h.id === 'old')?.remoteIds).toBeUndefined()
  })

  it('sends a thought with skipped words as tagged runs, in order, the note on the first', async () => {
    const t = setup()
    t.add(hl('a', { pending: true, text: 'setup … punchline', parts: ['setup', 'punchline'], note: 'ha' }))
    await t.sync.sync()
    expect(t.created).toEqual([
      { text: 'setup', note: '.c1 ha', location: 30000 },
      { text: 'punchline', note: '.c2', location: 30001 },
    ])
  })

  it('sends highlights oldest first', async () => {
    const t = setup()
    t.set({ highlights: [hl('second', { pending: true }), hl('first', { pending: true })] })
    await t.sync.sync()
    expect(t.created.map((c) => c.text)).toEqual(['text first', 'text second'])
  })

  it('a failed run stays pending with what landed, and the retry sends only the rest', async () => {
    let down = true
    const t = setup({ fail: (text) => down && text === 'punchline' })
    t.add(hl('a', { pending: true, parts: ['setup', 'punchline'] }))
    await t.sync.sync()
    expect(t.state.highlights[0]).toMatchObject({ remoteIds: ['1'], pending: true })
    down = false
    await t.sync.sync()
    expect(t.created.map((c) => c.text)).toEqual(['setup', 'punchline'])
    expect(t.state.highlights[0]).toMatchObject({ remoteIds: ['1', '2'], pending: undefined })
  })

  it('removing a highlight removes its runs from Readwise', async () => {
    const t = setup()
    t.add(hl('a', { pending: true, parts: ['x', 'y'] }))
    await t.sync.sync()
    t.drop('a')
    await t.sync.sync()
    expect(t.removed).toEqual(['1', '2'])
    expect(t.queue()).toEqual([])
  })

  it('a removal that fails is kept and tried again', async () => {
    const t = setup({ removeFails: true })
    t.set({ highlights: [hl('a', { remoteIds: ['5'] })] })
    t.drop('a')
    await t.sync.sync()
    expect(t.queue()).toEqual(['5'])
    t.opts.removeFails = false
    await t.sync.sync()
    expect(t.removed).toEqual(['5'])
    expect(t.queue()).toEqual([])
  })

  it('a highlight removed while it was being written comes back out', async () => {
    const t = setup()
    const { started, release } = hold(t.deps)
    t.add(hl('a', { pending: true }))
    const running = t.sync.sync()
    await started
    t.drop('a')
    release()
    await running
    expect(t.removed).toEqual(['1'])
  })

  it('a write that lands after a switch to another book is saved on its own book', async () => {
    const t = setup()
    const { started, release } = hold(t.deps)
    t.saved.set('readwise:r1', [hl('a', { pending: true })])
    t.add(hl('a', { pending: true }))
    const running = t.sync.sync()
    await started
    t.set({ doc: doc('url:https://elsewhere'), highlights: [] })
    release()
    await running
    expect(t.saved.get('readwise:r1')?.[0]).toMatchObject({ remoteIds: ['1'], pending: undefined })
    expect(t.removed).toEqual([])
  })

  it('a highlight removed mid-write, then a switch to another book, still comes back out', async () => {
    const t = setup()
    const { started, release } = hold(t.deps)
    t.add(hl('a', { pending: true }))
    const running = t.sync.sync()
    await started
    t.drop('a')
    t.saved.set('readwise:r1', []) // what saveNow wrote on the switch
    t.set({ doc: doc('url:https://elsewhere'), highlights: [] })
    release()
    await running
    expect(t.removed).toEqual(['1'])
  })

  it('a document missing from the cached library keeps its highlights pending', async () => {
    const t = setup({ inLibrary: false })
    t.add(hl('a', { pending: true }))
    await t.sync.sync()
    expect(t.created).toEqual([])
    expect(t.state.highlights[0].pending).toBe(true)
  })

  it('opening a document sends what it still owes', async () => {
    const t = setup()
    t.set({ doc: doc('url:x'), highlights: [] })
    t.set({ doc: doc('readwise:r1'), highlights: [hl('a', { pending: true })] })
    await t.sync.sync()
    expect(t.created).toHaveLength(1)
  })
})
