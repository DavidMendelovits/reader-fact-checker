# Changelog

All notable changes to readwithme are documented here. Versions are MAJOR.MINOR.PATCH.MICRO.

## [0.2.0.0] - 2026-09-20

### Added
- One Composer bar on every screen, on the phone and on the web: mic, a single status line (your live words while you talk, then the agent's reply, then "Reading ¶12/340"), play/pause while a book is open, a transcript sheet, and a keyboard glyph that opens a text field that never hides behind the keyboard.
- Talk over the narration and it stops on the first sound, not after three recognized words; a cough pauses it for a moment and it picks up by itself.
- Books open at the saved spot with no scroll animation; a "Back to the voice" pill appears when you scroll away while it reads.
- An aurora around the edges of the screen that rises with your voice, sweeps while the agent thinks, and pulses while it reads (Skia on the phone, WebGL on the web); it stays quiet at rest and still under reduced motion.
- Paper and Ink themes on the phone, following the system or chosen in Settings; a speed pill in the reader header; a transcript sheet with filing; an on-device voice download with a real progress bar.
- Web: a transcript sheet under 900px, "Play from here" on a text selection, an import screen with loading and error states.
- The line tells you when you are offline ("Offline. Reading still works."), when the mic needs a tap or was blocked, and when the library sync failed.

### Changed
- The product is now called readwithme on the phone, the web, and in the README.
- The voice code both apps share (hold/release, barge-in, recognizer restarts, echo handling, the agent loop) lives in `shared/voice/` and runs on both platforms.
- The Readwise token is stored in the keychain on the phone (migrated from app storage on first launch).
- Reading text is a serif; the web's UI font is the system stack.

### Fixed
- "Keep going" after a pause now restarts the audio instead of only saying "Reading".
- Speech was missed after the recognizer restarted; the first words of an interruption were read over.
- The reader no longer re-renders every paragraph on every agent state change; the web reader skips layout for off-screen paragraphs.
- The last paragraph is never hidden under the bar; the toast never covers the type field.

### Removed
- The four-row reader footer, the separate "or type it…" boxes, the header mic toggle, the floating waveform pill, and the `voice-glow` dependency.
