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
