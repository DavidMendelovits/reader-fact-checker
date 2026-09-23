// Self-check for the drawn glyph set. Run it with:
//
//   node --experimental-strip-types shared/voice/glyphs.check.ts
//
// A glyph that fails to parse is invisible, not broken-looking: react-native-svg
// and the browser both drop a bad `d` silently, and a bar of empty 44pt targets
// is the kind of thing a screenshot review misses.
import assert from 'node:assert/strict'
import { GLYPHS, MIC_SLASH, type GlyphName } from './glyphs.ts'

/** Every name the apps may ask for. Adding a glyph means adding it here. */
const NAMES: GlyphName[] = ['mic', 'play', 'pause', 'bubble', 'keyboard', 'send', 'close']

// Path data only: no stroke attributes smuggled in, no font fallbacks, nothing
// the two renderers disagree about.
const PATH = /^[MmLlHhVvCcSsQqTtAaZz0-9 .,-]+$/

for (const [name, d] of Object.entries(GLYPHS)) {
  assert.equal(typeof d, 'string', `${name}: not a string`)
  assert.ok(d.length > 0, `${name}: empty`)
  assert.ok(d.startsWith('M'), `${name}: does not start with a moveto`)
  assert.ok(PATH.test(d), `${name}: illegal characters in the path data`)
  assert.ok(NAMES.includes(name as GlyphName), `${name}: not listed in NAMES`)
}

// and the other way: nothing listed is missing from the set
for (const name of NAMES) assert.ok(name in GLYPHS, `${name}: listed but not drawn`)
assert.equal(Object.keys(GLYPHS).length, NAMES.length)

assert.ok(MIC_SLASH.startsWith('M') && PATH.test(MIC_SLASH), 'MIC_SLASH: bad path data')

console.log('glyphs: ok')
