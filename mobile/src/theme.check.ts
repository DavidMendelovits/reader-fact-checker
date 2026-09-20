// Self-check for the design tokens. Run it with:
//
//   node --experimental-strip-types src/theme.check.ts
//
// A theme is only a theme if its text is readable on every surface it lands on,
// in both palettes. WCAG 2.1: 4.5:1 for body text, 3:1 for meta text. The washes
// are translucent, so each is composited over the canvas before it is measured.
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

// theme.ts imports react-native (and, through settings.ts, AsyncStorage), whose
// Flow sources node cannot parse. Only the token values matter here.
const RN = 'data:text/javascript,export const Platform={OS:"ios",select:(o)=>o.ios??o.default};export const useColorScheme=()=>"light";'
const EMPTY = 'data:text/javascript,export default {};'
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === 'react-native') return { url: RN, shortCircuit: true }
    if (spec.includes('async-storage')) return { url: EMPTY, shortCircuit: true }
    return next(spec, ctx)
  },
})

const { Ink, Paper } = await import('./theme.ts')
type Theme = typeof Paper

/** #rgb, #rrggbb or #rrggbbaa → [r, g, b, alpha 0..1]. */
function parse(hex: string): [number, number, number, number] {
  const h = hex.replace('#', '')
  const n = (i: number) => parseInt(h.slice(i * 2, i * 2 + 2), 16)
  return [n(0), n(1), n(2), h.length === 8 ? n(3) / 255 : 1]
}

/** Lay a possibly translucent colour over an opaque one. */
function over(fg: string, bg: string): string {
  const [r, g, b, a] = parse(fg)
  const [br, bg_, bb] = parse(bg)
  const mix = (f: number, k: number) => Math.round(f * a + k * (1 - a))
  return '#' + [mix(r, br), mix(g, bg_), mix(b, bb)].map((v) => v.toString(16).padStart(2, '0')).join('')
}

function luminance(hex: string): number {
  const [r, g, b] = parse(hex)
  const lin = (v: number) => {
    const c = v / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

function contrast(fg: string, bg: string): number {
  const [a, b] = [luminance(fg), luminance(bg)].sort((x, y) => y - x)
  return (a + 0.05) / (b + 0.05)
}

// sanity: the two ends of the scale
assert.equal(Math.round(contrast('#ffffff', '#000000')), 21)
assert.equal(contrast('#888888', '#888888'), 1)
assert.equal(over('#ffffff80', '#000000'), '#808080')

function check(theme: Theme) {
  const on: [string, string][] = [
    ['canvas', theme.canvas],
    ['surface', theme.surface],
    ['surfaceSecondary', theme.surfaceSecondary],
    ['currentWash', over(theme.currentWash, theme.canvas)],
    ['highlightWash over canvas', over(theme.highlightWash, theme.canvas)],
  ] // `highlight` is not here: it is the full-strength rule under a mark, never a
    // text background — marked text sits on highlightWash, as it does on the web.
  for (const [label, bg] of on) {
    for (const text of ['textPrimary', 'textSecondary'] as const) {
      const ratio = contrast(theme[text], bg)
      assert.ok(ratio >= 4.5, `${theme.name}: ${text} on ${label} is ${ratio.toFixed(2)}:1, want 4.5:1`)
    }
    const meta = contrast(theme.textTertiary, bg)
    assert.ok(meta >= 3, `${theme.name}: textTertiary on ${label} is ${meta.toFixed(2)}:1, want 3:1`)
  }
  const onAccent = contrast(theme.textOnAccent, theme.accent)
  assert.ok(onAccent >= 4.5, `${theme.name}: textOnAccent on accent is ${onAccent.toFixed(2)}:1, want 4.5:1`)

  assert.equal(theme.auroraUser.length, 7)
  assert.equal(theme.auroraAgent.length, 7)
  for (const c of [...theme.auroraUser, ...theme.auroraAgent]) assert.match(c, /^#[0-9a-f]{6}$/)
}

check(Paper)
check(Ink)
console.log('theme: contrast ok (Paper, Ink)')
