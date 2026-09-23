// The phone's half of the one glyph set (shared/voice/glyphs.ts).
//
// Drawn, not typed: a text glyph is whatever the OS font happens to have, and
// ❚❚ ⌨ ☰ were three different weights on the same bar. Skia stays out of this —
// the Expo web export loads the Composer, and Skia does not survive that.
import { memo } from 'react'
import Svg, { Path } from 'react-native-svg'
import { GLYPHS, MIC_SLASH, type GlyphName } from '../../../shared/voice/glyphs'

export { MIC_SLASH }
export type { GlyphName }

/**
 * Primitive props only — no style objects, no theme — so `memo` actually hits:
 * the Composer re-renders on every interim word, several times a second.
 */
export const Glyph = memo(function Glyph({
  name, color, size = 20,
}: { name: GlyphName; color: string; size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path d={GLYPHS[name]} fill={color} fillRule="evenodd" />
    </Svg>
  )
})
