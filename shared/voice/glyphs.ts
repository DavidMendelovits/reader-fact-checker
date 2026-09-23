// One glyph set for both surfaces.
//
// The bar used to be typed: ❚❚ ▶ ☰ ⌨ ↑ ✕ on the phone, a 🎙 emoji on the web,
// and ✦ ✎ 📄 scattered through the panels. Six fonts rendered them six ways, the
// emoji brought its own colour, and ☰ read as a menu rather than a transcript.
// These are paths instead: one 24×24 box, one fill, the app's own accent colour.
//
// Each value is a path `d` on a 24×24 viewBox. Single filled shape, no stroke —
// subpaths never overlap, so nonzero and evenodd draw the same thing and the
// renderers can ask for evenodd without punching holes. Drawn for a 1.5–2px
// visual weight at 18–20pt.

export const GLYPHS = {
  /** A capsule on a stand. The one mic in either app. */
  mic: 'M12 2a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3zM5 10.5h1.8v0.5a5.2 5.2 0 0 0 10.4 0v-0.5H19v0.5a7 7 0 0 1-14 0zM11.1 18h1.8v2.2H16V22H8v-1.8h3.1z',
  /** Play: a triangle. */
  play: 'M8 5l12 7-12 7z',
  /** Pause: two bars. */
  pause: 'M7 4h3.5v16H7zM13.5 4H17v16h-3.5z',
  /**
   * The transcript: a speech bubble with a tail. ☰ read as a menu. Hollowed
   * with evenodd so it carries the same weight as the keyboard beside it.
   */
  bubble: 'M5 3h14a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3h-10l-3 4v-4H5a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3zM5.3 4.8h13.4a1.5 1.5 0 0 1 1.5 1.5v7.4a1.5 1.5 0 0 1-1.5 1.5H5.3a1.5 1.5 0 0 1-1.5-1.5V6.3a1.5 1.5 0 0 1 1.5-1.5z',
  /** Type instead of talking: a keyed rect, hollowed with evenodd. */
  keyboard: 'M4 5h16a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H4a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3zM4.4 6.8h15.2a1.6 1.6 0 0 1 1.6 1.6v6.8a1.6 1.6 0 0 1-1.6 1.6H4.4a1.6 1.6 0 0 1-1.6-1.6V8.4a1.6 1.6 0 0 1 1.6-1.6zM4.15 9.15h1.7v1.7h-1.7zM6.95 9.15h1.7v1.7h-1.7zM9.75 9.15h1.7v1.7h-1.7zM12.55 9.15h1.7v1.7h-1.7zM15.35 9.15h1.7v1.7h-1.7zM18.15 9.15h1.7v1.7h-1.7zM7 13h10v1.7H7z',
  /** Send: an up arrow. */
  send: 'M12 2.5l8 8-2.1 2.1-4.4-4.4V21h-3V8.2l-4.4 4.4L4 10.5z',
  /** Close: one polygon, never two crossed bars — those would hole out. */
  close: 'M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
} as const

export type GlyphName = keyof typeof GLYPHS

/**
 * The bar struck through the mic when the OS has taken it away. Drawn on top of
 * `mic` in the danger colour, not baked into it: only the denied state has it.
 */
export const MIC_SLASH = 'M3.3 4.7L4.7 3.3 20.7 19.3 19.3 20.7z'
