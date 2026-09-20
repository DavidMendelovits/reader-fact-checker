# TODOS

## Barge-in floor per audio route (Bluetooth)
- **What:** Calibrate the sound-based barge-in floor per output route (speaker / wired / Bluetooth) from the iOS audio route, instead of one constant.
- **Why:** Echo cancellation degrades on Bluetooth (output latency drifts), so a floor tuned on the speaker can pause narration on its own voice through AirPods.
- **Pros:** The fast stop stays correct on the most common listening setup.
- **Cons:** Needs a real-device matrix (AirPods, wired, speaker) to tune three constants.
- **Context:** `mobile/src/voice.ts` fires `onSpeechStart` when two consecutive `volumechange` reports exceed the floor while narration plays (plan: ~/.claude/plans/mobile-ui-overhaul.md, decision 3.2A). AVAudioSession route-change events identify the route.
- **Depends on / blocked by:** The hold/release barge-in (3.2A) shipping first.
- Added 2026-09-20 by /plan-design-review.

## (resolved in-plan) Shared voice layer: agent loop extraction
- Chosen "build now" (T18 in ~/.claude/plans/mobile-ui-overhaul.md) during /plan-eng-review on 2026-09-20; kept here only as a pointer.

## iOS 26 scroll-edge ghost under the Composer bar
- **What:** On the iOS 26.2 simulator, UIScrollView paints a faded extension of the list's off-screen content below the list's bottom edge, which shows through the opaque Composer bar as ghost text. React Native 0.86 exposes no switch for it.
- **Why:** Cosmetic, but it reads as a translucent bar. Verified not caused by the bar (opaque fill, no aurora, plain View, z-index, clipping all left it unchanged; the list already ends at the bar's top edge).
- **Pros of fixing:** clean bar on iOS 26 devices.
- **Cons:** needs native code: either `@strollerapp/react-native-scroll-edge-effect` (a dependency) or a small config plugin that sets `bottomEdgeEffect.isHidden` on RCTScrollView.
- **Context:** `mobile/src/ui/LibraryScreen.tsx` and `ReaderList.tsx` (list container margin/clip); screenshots in the 2026-09-20 session. Check first whether it appears on a real iOS 26 device and on iOS 18.
- Added 2026-09-20 by the agent-device run.
