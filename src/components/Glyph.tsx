// The web's half of the one glyph set (shared/voice/glyphs.ts).
//
// It replaces the mic emoji and the sparkles, pencils and pages scattered through
// the panels: emoji bring their own colour and their own metrics, and no emoji
// followed the theme. Nothing under src/components is typed as a picture any more.
import { GLYPHS, type GlyphName } from '../../shared/voice/glyphs.ts'

export type { GlyphName }

/**
 * `currentColor` by default, so a glyph inherits whatever the button already is
 * and both themes come for free. Always aria-hidden: the button carries the label.
 */
export function Glyph({ name, color = 'currentColor', size = 20 }: { name: GlyphName; color?: string; size?: number }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" focusable="false">
      <path d={GLYPHS[name]} fill={color} fillRule="evenodd" />
    </svg>
  )
}
