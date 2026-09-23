// Self-check for the design tokens. Run it with:
//
//   node --experimental-strip-types src/tokens.check.ts
//
// Two things to keep honest. The roles DESIGN.md publishes have to be the
// numbers the app actually uses — the table is the contract. And the bookmark
// estimate in ui/layout.ts has to be reading those same numbers rather than a
// private copy of them, which is the whole reason tokens.ts exists.
import assert from 'node:assert/strict'
import { radius, reader, size, space, type, weight } from './tokens.ts'
import { estimateHeight } from './ui/layout.ts'

const W = 390

// ---- the type table ----
const ROLES = {
  reading: { fontSize: 17, lineHeight: 27 },
  heading: { fontSize: 22, lineHeight: 30, fontWeight: '600' },
  title: { fontSize: 24, lineHeight: 30, fontWeight: '700' },
  ui: { fontSize: 15, lineHeight: 20 },
  prose: { fontSize: 15, lineHeight: 22 },
  row: { fontSize: 16, lineHeight: 22, fontWeight: '500' },
  meta: { fontSize: 13, lineHeight: 18 },
  glyph: { fontSize: 18, lineHeight: 22 },
  chevron: { fontSize: 20 },
  input: { fontSize: 16 },
} as const
for (const [name, want] of Object.entries(ROLES)) {
  assert.deepEqual(type[name as keyof typeof ROLES], want, `type.${name} is not what DESIGN.md says`)
}
assert.deepEqual(Object.keys(type), Object.keys(ROLES), 'a role was added or dropped without DESIGN.md')

// Nothing is set below 13 (DESIGN.md, Type).
for (const [name, role] of Object.entries(type)) {
  assert.ok(role.fontSize >= 13, `${name} is set below 13`)
}

// ---- the scales ----
assert.deepEqual(Object.values(space), [4, 8, 12, 16, 20, 24])
assert.deepEqual(Object.values(radius), [8, 12, 999])
assert.equal(weight.semibold, '600')
assert.equal(size.target, 44, 'the smallest tap target is 44')
assert.equal(size.micCircle, 36)

// ---- the bookmark estimate reads these tokens ----
// A one-line paragraph is one line of reading type plus the row's padding.
assert.equal(estimateHeight('short', W, false), type.reading.lineHeight + reader.rowPadding)

// A heading is one line of heading type, the same padding, plus its own space.
assert.equal(
  estimateHeight('Chapter One', W, true),
  type.heading.lineHeight + reader.rowPadding + reader.headingPadding,
)

// And the reader's gutter really is the two column paddings it claims to be.
assert.equal(reader.gutter, space.xl * 2)
assert.equal(reader.rowPadding, space.sm * 2)
assert.equal(reader.headingPadding, space.xxl * 2)

console.log('tokens: the type table holds, and the bookmark estimate reads it')
