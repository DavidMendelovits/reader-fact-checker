// How much of the bottom of the screen is chrome.
//
// The Composer is pinned over everything, and the keyboard slides it further up,
// so the reader's last paragraph and the "back to the voice" pill both need to
// know how much room is taken (X6). The Composer measures itself and reports it
// here; anything that has to clear it subscribes.
import { useSyncExternalStore } from 'react'
import { useKeyboardState } from 'react-native-keyboard-controller'

/** Room kept above the Composer for the "↓ Back to the voice" pill. */
export const BACK_TO_VOICE_RESERVE = 48

/** The Composer's own height before it has measured itself: 60pt + a home indicator. */
let composerHeight = 94
const listeners = new Set<() => void>()

/** Called by the Composer's onLayout. Whole points only: this drives list padding. */
export function setComposerHeight(height: number) {
  const next = Math.round(height)
  if (next === composerHeight || next <= 0) return
  composerHeight = next
  listeners.forEach((l) => l())
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

const snapshot = () => composerHeight

export function useComposerHeight(): number {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

const keyboardHeight = (s: { isVisible: boolean; height: number }) => (s.isVisible ? s.height : 0)

/**
 * Composer + keyboard + the pill's reserve.
 *
 * X6 spells this as composer + keyboard + (keyboard closed ? insets.bottom : 0)
 * + 48. The safe-area inset is not added again here because the Composer pads
 * itself by it and then measures the result — it is already inside
 * `composerHeight`, and drops out of the measurement when the keyboard is up.
 *
 * ponytail: the keyboard height is JS state, not a shared value, so the list's
 * padding steps rather than tracking the keyboard frame by frame. The Composer
 * itself rides a KeyboardStickyView and does track it; the padding change
 * happens below the fold, where nobody can see it.
 */
export function useBottomInset(): number {
  const composer = useComposerHeight()
  const keyboard = useKeyboardState(keyboardHeight)
  return composer + keyboard + BACK_TO_VOICE_RESERVE
}
