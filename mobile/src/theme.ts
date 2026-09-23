// The phone's design tokens. Two themes — Paper (light) and Ink (dark) — under the
// same semantic names the web uses in src/styles.css, so DESIGN.md is one document
// for both surfaces. Components read these names and never a literal.
import { Platform, useColorScheme } from 'react-native'
import { useSyncExternalStore } from 'react'
// .ts extension: theme.check.ts loads this file in plain node, which needs it.
import { saveTheme, type ThemePreference } from './settings.ts'
import { radius, size, space, type as tokens, weight } from './tokens.ts'

// The numbers live in tokens.ts, which imports nothing — the bookmark estimate
// reads them too, and it runs outside react-native. Re-exported here so a
// component still has one place to import from.
export { radius, size, space, weight }

export interface Theme {
  name: 'paper' | 'ink'
  /** The page behind everything. */
  canvas: string
  /** Cards, sheets, inputs: one step off the canvas. */
  surface: string
  /** Quiet fills — search field, tab strip, wells. */
  surfaceSecondary: string
  textPrimary: string
  textSecondary: string
  /** Meta text: dates, counts, hints. Held to 3:1, never used for body. */
  textTertiary: string
  accent: string
  hairline: string
  /** Full-strength highlight (the rule under a mark). */
  highlight: string
  /** The wash behind highlighted text; alpha over whatever is beneath. */
  highlightWash: string
  /** The paragraph being read. */
  currentWash: string
  danger: string
  micLive: string
  textOnAccent: string
  /** Aurora palette while the user talks: warm. */
  auroraUser: string[]
  /** Aurora palette while the agent talks: cool. */
  auroraAgent: string[]
}

const AURORA_USER = ['#ffc915', '#ffb07a', '#eb64a0', '#ff8a3d', '#f26d4b', '#ffd9a0', '#c2417a']
const AURORA_AGENT = ['#7ec4ff', '#9aa0ff', '#7fd9ee', '#5fa8e8', '#b3a6ff', '#6fe0c8', '#4f7fd4']

export const Paper: Theme = {
  name: 'paper',
  canvas: '#faf8f4',
  surface: '#ffffff',
  surfaceSecondary: '#f1ece3',
  textPrimary: '#1a1712',
  textSecondary: '#3c372e',
  textTertiary: '#8d867a',
  accent: '#8a5a2b',
  hairline: '#e8e2d6',
  highlight: '#f6e7a8',
  highlightWash: '#fce15a47', // hsl(50 96% 67% / 0.28), the web's highlight wash
  currentWash: '#f3ead8',
  danger: '#8a3b2b',
  micLive: '#2b6a3f',
  textOnAccent: '#faf8f4',
  auroraUser: AURORA_USER,
  auroraAgent: AURORA_AGENT,
}

export const Ink: Theme = {
  name: 'ink',
  canvas: '#10161d',
  surface: '#151c23',
  surfaceSecondary: '#1f272f',
  textPrimary: '#e0e3e6',
  textSecondary: '#88929c',
  textTertiary: '#6e7883',
  accent: '#c9955a', // brass, lifted until it carries dark text at 4.5:1
  hairline: '#28313b',
  highlight: '#a4780e',
  highlightWash: '#fce15a1a', // 0.10, not the web's 0.22: any more and body text
                              // over the wash drops below 4.5:1 on this canvas
  currentWash: '#1f2a2f',
  danger: '#f08a84',
  micLive: '#79c97d',
  textOnAccent: '#10161d',
  auroraUser: AURORA_USER,
  auroraAgent: AURORA_AGENT,
}

/** Reading is a built-in serif; chrome is the system face. */
const readingFamily = Platform.select({ ios: 'Georgia', default: 'serif' })

/** The token roles, with the one platform-dependent field the serif needs. */
export const type = {
  ...tokens,
  reading: { ...tokens.reading, fontFamily: readingFamily },
} as const

// The override lives here rather than in the zustand store: the store is the open
// document, and the theme has to be readable before a document exists.
let preference: ThemePreference = 'system'
const listeners = new Set<() => void>()

/** The override as it stands. Settings' theme control reads it to show itself. */
export const themePreference = (): ThemePreference => preference

/** Set (and remember) the override. Pass what `loadSettings()` returned on boot. */
export function setThemePreference(next: ThemePreference) {
  if (next === preference) return
  preference = next
  listeners.forEach((l) => l())
  void saveTheme(next)
}

export function useTheme(): Theme {
  const scheme = useColorScheme()
  const pref = useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => preference,
  )
  if (pref === 'paper') return Paper
  if (pref === 'ink') return Ink
  return scheme === 'dark' ? Ink : Paper
}
