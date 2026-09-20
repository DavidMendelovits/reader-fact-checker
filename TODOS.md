# TODOS

## Voice

### Barge-in floor per audio route (Bluetooth)

**What:** Calibrate the sound-based barge-in floor per output route (speaker / wired / Bluetooth) from the iOS audio route, instead of one constant.

**Why:** Echo cancellation degrades on Bluetooth (output latency drifts), so a floor tuned on the speaker can pause narration on its own voice through AirPods.

**Context:** `mobile/src/voice.ts` fires `onSpeechStart` when two consecutive `volumechange` reports exceed the floor while narration plays (the overhaul plan, decision 3.2A; the plan lives outside the repo). AVAudioSession route-change events identify the route. Needs a device matrix (AirPods, wired, speaker) to tune three constants.

**Effort:** M
**Priority:** P3
**Depends on:** the hold/release barge-in (shipped in v0.2.0.0) and the `__DEV__` level overlay below

### `__DEV__` level/floor overlay in the Composer

**What:** In dev builds, draw the live mic level and the barge-in floor in the Composer so the floor can be tuned on a real phone.

**Why:** Plan 3.2A required it; without it the 0.25 floor is a guess until the real-device speaker test.

**Context:** `shared/voice/bargeIn.ts` holds the floor; `mobile/src/levels.ts` `getMicLevel()` is the source; the overlay is a 2px bar in `mobile/src/ui/Composer.tsx` gated on `__DEV__`.

**Effort:** S
**Priority:** P1
**Depends on:** None

### Haptics beyond fast commands

**What:** Light tap on speech start, warning on mic denied, selection tick on a highlight created.

**Why:** Plan Pass 2 state table; today only a fast command ticks (`mobile/src/ui/kit.ts`).

**Context:** `expo-haptics` is installed; call sites are `beginUtterance` (via the adapter), the mic-denied branch in `mobile/App.tsx`, and `highlightParagraph`/`addHighlight` in `mobile/src/session.ts`.

**Effort:** S
**Priority:** P1
**Depends on:** None

### Web keyboard inset from `visualViewport`

**What:** Size the web reader's bottom inset from `visualViewport.height` so the last paragraph clears the Composer with the keyboard open, as the phone does.

**Why:** Plan X6; today the web relies on `100dvh` + `interactive-widget=resizes-content`, which covers Chrome but not every browser.

**Context:** `src/components/Composer.tsx` reports its height; add a `visualViewport` resize listener and apply `scroll-padding-bottom` on `.reader`.

**Effort:** S
**Priority:** P1
**Depends on:** None

## Tests

### Extend `highlights.check.ts` and add a memo-props regression check

**What:** Assert `NO_MARKS` identity and that `ParagraphRow` (mobile) / `Paragraph` (web) props stay referentially stable across unrelated store updates.

**Why:** Plan T15; the reader-performance work (T6) is otherwise verified only by a manual profiler run.

**Context:** `mobile/src/ui/ReaderList.tsx` (`NO_MARKS`, `useCallback` handlers), `src/components/Reader.tsx` (`memo(Paragraph)`, `highlightByAnchor`, `jobIndex`).

**Effort:** S
**Priority:** P1
**Depends on:** None

## Maintainability

### `themed()` style-cache helper

**What:** One helper in `mobile/src/ui/kit.ts` owning the WeakMap-per-theme StyleSheet cache, replacing the 9-line boilerplate copied into 11 UI files.

**Why:** Review finding (maintainability 9/10): eleven verbatim copies drift.

**Context:** Every file under `mobile/src/ui/` has `const cache = new WeakMap<Theme, …>(); function styles(theme) { … build(theme) }`.

**Effort:** S
**Priority:** P2
**Depends on:** None

### React-native-free `tokens.ts` shared by the theme and the bookmark estimate

**What:** Move type sizes and spacing into a platform-free module imported by both `mobile/src/theme.ts` and `mobile/src/ui/layout.ts`.

**Why:** `layout.ts` re-declares 17/27, 22/30, gutters and paddings as literals; a type change drifts the estimate from the render silently.

**Context:** `mobile/src/ui/layout.ts` (`BODY`, `HEADING`, `GUTTER`, `ROW_PADDING`, `HEADING_PADDING`) vs `theme.ts` (`type`, `space`). Also fold the component-level type literals (24/700 screen titles, 16/22 rows, 18–20pt glyphs) into named roles.

**Effort:** S
**Priority:** P2
**Depends on:** None

### Typed mic errors and a typed notice

**What:** `Transcriber.onError(kind, message)` (`denied` | `unstable` | `other`) and `notice: { text, kind }` so the Composer's mic state and the Toast's severity stop regex-matching strings.

**Why:** Both `mobile/App.tsx` and `mobile/src/ui/Toast.tsx` classify by matching human-readable strings; rewording either silently breaks the UI state.

**Context:** `mobile/App.tsx` `voice.onError` wrapper; `mobile/src/ui/Toast.tsx` `isError` regex; `src/components/Composer.tsx` matches `notice` for the denied state; `mobile/src/ui/Composer.tsx` ticks on `/^(Paused|Reading)\.$/`.

**Effort:** M
**Priority:** P2
**Depends on:** None

### Share recognizer death-counting between listeners

**What:** Fold the rapid-death detection (mobile: 3 in 30s; web: 8 with backoff) into `shared/voice/restartPolicy.ts` with injected thresholds and one error-message constant.

**Why:** Two implementations of the same policy with the same literal error string.

**Context:** `mobile/src/voice.ts` `tooManyDeaths()`; `src/lib/voice.ts` rapid-death backoff.

**Effort:** S
**Priority:** P2
**Depends on:** None

### Shared speed presets and label

**What:** One `SPEEDS` list and `speedLabel()` in `shared/voice`, used by `mobile/src/ui/SpeedSheet.tsx` and `src/components/Header.tsx`.

**Why:** The lists are duplicated and the labels disagree (`1.0×` vs `1×`).

**Effort:** S
**Priority:** P2
**Depends on:** None

## Platform

### iOS 26 scroll-edge ghost under the Composer bar

**What:** On the iOS 26.2 simulator, UIScrollView paints a faded extension of the list's off-screen content below the list's bottom edge, which shows through the opaque Composer bar as ghost text. React Native 0.86 exposes no switch for it.

**Why:** Cosmetic, but it reads as a translucent bar. Verified not caused by the bar (opaque fill, no aurora, plain View, z-index, clipping all left it unchanged; the list already ends at the bar's top edge).

**Context:** Needs native code: either `@strollerapp/react-native-scroll-edge-effect` (a dependency) or a small config plugin that sets `bottomEdgeEffect.isHidden` on RCTScrollView. `mobile/src/ui/LibraryScreen.tsx` and `ReaderList.tsx` (list container margin/clip). Check first whether it appears on a real iOS 26 device and on iOS 18.

**Effort:** M
**Priority:** P2
**Depends on:** None

## Completed

### Shared voice layer: agent loop extraction

**What:** Move the conversation loop into `shared/voice/agent.ts` behind the existing ports, with both apps as thin adapters.

**Completed:** v0.2.0.0 (2026-09-20)
