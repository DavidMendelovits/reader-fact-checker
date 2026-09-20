# readwithme — design system

Written from `mobile/src/theme.ts` (phone) and `src/styles.css` (web); the semantic names are the same on both surfaces, so this is one document.

## Themes

Paper is the light theme, Ink the dark one; `useTheme()` follows the OS unless Settings pins one.

| Token | Paper | Ink | Used for |
|---|---|---|---|
| `canvas` | `#faf8f4` | `#10161d` | the page behind everything |
| `surface` | `#ffffff` | `#151c23` | cards, sheets, inputs |
| `surfaceSecondary` | `#f1ece3` | `#1f272f` | search field, tab strip, wells |
| `textPrimary` | `#1a1712` | `#e0e3e6` | titles, headings, marked text |
| `textSecondary` | `#3c372e` | `#88929c` | reading body, quiet labels |
| `textTertiary` | `#8d867a` | `#6e7883` | meta: dates, counts, hints |
| `accent` | `#8a5a2b` | `#c9955a` | brass: links, active tab, filing |
| `textOnAccent` | `#faf8f4` | `#10161d` | text on an accent fill |
| `hairline` | `#e8e2d6` | `#28313b` | 1px rules, borders |
| `highlight` | `#f6e7a8` | `#a4780e` | full-strength rule under a mark |
| `highlightWash` | `#fce15a47` (0.28) | `#fce15a1a` (0.10) | the wash behind marked text |
| `currentWash` | `#f3ead8` | `#1f2a2f` | the paragraph being read |
| `danger` | `#8a3b2b` | `#f08a84` | sign out, destructive, errors |
| `micLive` | `#2b6a3f` | `#79c97d` | the mic button while listening |
| `auroraUser` | 7 warm hues: `#ffc915 #ffb07a #eb64a0 #ff8a3d #f26d4b #ffd9a0 #c2417a` | same | aurora while the user talks |
| `auroraAgent` | 7 cool hues: `#7ec4ff #9aa0ff #7fd9ee #5fa8e8 #b3a6ff #6fe0c8 #4f7fd4` | same | aurora while the agent talks |

`src/theme.check.ts` asserts the contrast floors in both themes: body text ≥ 4.5:1 on canvas, surface, surfaceSecondary, currentWash and highlightWash-over-canvas; meta text ≥ 3:1 on the same; `textOnAccent` on `accent` ≥ 4.5:1.

## Type

Reading is a built-in serif, chrome is the system face; nothing is below 13.

| Role | Family | Size / line | Weight |
|---|---|---|---|
| Reading body | Georgia (iOS) / serif (Android) / Source Serif 4 (web) | 17 / 27 | 400 |
| Heading | same serif | 22 / 30 | 600 |
| UI | system | 15 / 20 | 400–600 |
| Meta | system | 13 / 18 | 400 |

Web body is ≥ 16px so iOS does not zoom on focus; reader text respects Dynamic Type to 1.5×.

## Spacing

`4 · 8 · 12 · 16 · 20 · 24` (`space.xs…xxl`). Screen gutter 16; reader column gutter 20; the reader column keeps a 12pt inner margin the aurora never crosses.

## Radii

`8` inputs and buttons · `12` cards and sheets · `999` pills.

## Motion

| What | Duration | Curve |
|---|---|---|
| Chrome: toasts, sheets, tint fades | 150–200ms | ease-out |
| Composer expand / collapse | spring | — |
| Current-paragraph tint | 150ms | ease-out |
| Aurora rise (user voice) | 300ms attack / 850ms release | — |
| Aurora thinking sweep | ~1.1s loop | — |
| Aurora reading pulse | 0.28 ± 0.12, ~1.1s loop | — |

Aurora rests at ≤ 10% opacity. Reduced motion (`AccessibilityInfo.isReduceMotionEnabled` / `prefers-reduced-motion`): the aurora is a static wash and every transition drops to 0ms.

## Touch targets

44 × 44 minimum, everywhere — mic, play, transcript, keyboard, speed pill, library chevron, highlight ✕.

## Components

| Component | What it is |
|---|---|
| `Composer` | The bottom bar on every signed-in screen: mic · line · play/pause · transcript · keyboard; 60pt + safe-area inset, opaque canvas, hairline on top. |
| `TranscriptSheet` | Bottom sheet over the Composer, tabs Conversation \| Checks, last 30 lines, drag to dismiss. |
| `BackToVoicePill` | Pill above the Composer when the current paragraph is off-screen; tap resumes follow. |
| `SyncHairline` | 2px accent progress rule under the library tabs; red for 2s on a sync failure. |
| `Aurora` | The shader layer behind everything, vignetted to the frame edges. |
| `SpeedSheet` | Sheet from the header's speed pill: 0.8 / 1 / 1.2 / 1.5 / 2, plus the agent's value if it is not one of those. |

Every component takes tokens; no colour, size or radius literal lives in a component.
