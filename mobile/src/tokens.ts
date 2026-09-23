// The numbers. Sizes, line heights, weights, spacing, radii — and nothing else:
// no colour (that is a theme's job, and there are two of them) and no platform.
//
// This file imports nothing. That is the point. `theme.ts` reads it and adds the
// reading face on top; `ui/layout.ts` reads it to guess how tall a paragraph will
// be, and that file has to run in plain node — it cannot touch react-native. Both
// therefore agree on 17/27 by construction rather than by two people remembering.

/** `4 · 8 · 12 · 16 · 20 · 24`. Every margin, padding and gap is one of these. */
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 24 } as const

export const radius = { input: 8, card: 12, pill: 999 } as const

/**
 * Font weights by name, so a component never carries a bare `'600'`.
 */
export const weight = { regular: '400', medium: '500', semibold: '600', bold: '700' } as const

/**
 * The type roles. `reading` and `heading` are set in the serif that `theme.ts`
 * adds; the rest are the system face.
 *
 * Every role is a spreadable style object — `{ ...type.ui, color }` — so the
 * shape is uniform and a role can gain a field without touching its callers.
 */
export const type = {
  /** Body prose in the reader. */
  reading: { fontSize: 17, lineHeight: 27 },
  /** A chapter heading in the reader. */
  heading: { fontSize: 22, lineHeight: 30, fontWeight: weight.semibold },
  /** A screen's name: the one big line at the top of Library and Sign in. */
  title: { fontSize: 24, lineHeight: 30, fontWeight: weight.bold },
  /** Chrome: buttons, labels, transcript lines. */
  ui: { fontSize: 15, lineHeight: 20 },
  /** Chrome set as a paragraph — the same size, opened up to read. */
  prose: { fontSize: 15, lineHeight: 22 },
  /** A list row's title. */
  row: { fontSize: 16, lineHeight: 22, fontWeight: weight.medium },
  /** Dates, counts, hints. Nothing is smaller than this. */
  meta: { fontSize: 13, lineHeight: 18 },
  /** A glyph set in text rather than drawn. */
  glyph: { fontSize: 18, lineHeight: 22 },
  /** The chevron at the end of a list row, which reads small at 18. */
  chevron: { fontSize: 20 },
  /**
   * A text field. 16, not the UI 15: anything smaller and mobile Safari zooms
   * the page when the field takes focus.
   */
  input: { fontSize: 16 },
} as const

/** Fixed sizes that are not type and not spacing. */
export const size = {
  /** The bar in a sheet's grab handle. */
  grabBarWidth: 36,
  grabBarHeight: 4,
  /** The ring around the Composer's mic. */
  micCircle: 36,
  /** The smallest thing a thumb is ever asked to hit. */
  target: 44,
  /** A library row. */
  row: 56,
  /** The two bars of a library row while it is still loading. */
  skeletonTitle: 14,
  skeletonMeta: 10,
} as const

/**
 * What the bookmark estimate in `ui/layout.ts` needs to guess a row's height
 * before anything has been laid out.
 */
export const reader = {
  /** The reader column's horizontal padding, both sides (`space.xl` × 2). */
  gutter: 40,
  /** A row's vertical padding, both sides (`space.sm` × 2). */
  rowPadding: 16,
  /** A chapter heading's extra space above and below it (`space.xxl` × 2). */
  headingPadding: 48,
  /**
   * Mean glyph width as a fraction of the font size, for a serif reading face.
   * Measured against Georgia at 17pt on English prose; it only has to be close
   * enough that the corrective scroll is small.
   */
  charWidthRatio: 0.48,
} as const
