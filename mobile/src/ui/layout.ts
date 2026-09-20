// Where every paragraph sits, before anything has been laid out.
//
// Opening a book at its bookmark has to be instant (X3): FlatList needs a
// `getItemLayout` on the very first frame, long before it has measured a single
// row. So each paragraph's height is guessed from its character count, the
// guesses are stacked into an offset table, and `initialScrollIndex` lands the
// list on the bookmark straight away. As real rows report their heights they
// replace the guesses, and one non-animated correction fixes the drift.
//
// No React, no react-native: layout.check.ts runs this file in plain node.

/**
 * Mean glyph width as a fraction of the font size, for a serif reading face.
 * Measured against Georgia at 17pt on English prose; it only has to be close
 * enough that the corrective scroll is small.
 */
const CHAR_WIDTH_RATIO = 0.48

/**
 * The widest the reader column and the Composer ever get. Past a tablet's width
 * a full-bleed line of prose is unreadable, so both centre inside this (6.1A).
 */
export const COLUMN_MAX_WIDTH = 640

/** The reader column's horizontal padding, both sides (space.xl × 2). */
const GUTTER = 40

/** A row's vertical padding, both sides (space.sm × 2). */
const ROW_PADDING = 16

/** A chapter heading's extra space above and below it. */
const HEADING_PADDING = 48

const BODY = { size: 17, line: 27 }
const HEADING = { size: 22, line: 30 }

/**
 * A paragraph's height in points: how many lines its characters need at this
 * width, times the line height, plus the row's padding.
 *
 * `fontScale` is the OS text size (Dynamic Type); it grows the glyphs and the
 * line height together, so a big-text reader's bookmark lands in the right
 * place too.
 */
export function estimateHeight(text: string, width: number, isHeading: boolean, fontScale = 1): number {
  const { size, line } = isHeading ? HEADING : BODY
  const charWidth = size * CHAR_WIDTH_RATIO * fontScale
  const perLine = Math.max(1, Math.floor((width - GUTTER) / charWidth))
  const lines = Math.max(1, Math.ceil(text.length / perLine))
  return lines * line * fontScale + ROW_PADDING + (isHeading ? HEADING_PADDING : 0)
}

/**
 * The top of every row, stacked. Index `i` is where row `i` starts; the last
 * entry is the total content height, so the table is one longer than the list.
 *
 * A row that has actually been measured overrides its estimate — that is the
 * whole point: the further the reader scrolls, the more of the table is true.
 */
export function offsetsFrom(estimates: readonly number[], measured: ReadonlyMap<number, number>): number[] {
  const offsets = new Array<number>(estimates.length + 1)
  let y = 0
  for (let i = 0; i < estimates.length; i++) {
    offsets[i] = y
    y += measured.get(i) ?? estimates[i]
  }
  offsets[estimates.length] = y
  return offsets
}

/** The height of row `i` as the offset table has it. */
export function heightAt(offsets: readonly number[], index: number): number {
  return (offsets[index + 1] ?? 0) - (offsets[index] ?? 0)
}
