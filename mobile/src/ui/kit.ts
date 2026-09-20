// The four things every screen needs and none of them owns: an action sheet, an
// error message, whether the user has asked for less motion, and a haptic tick.
import { useEffect, useState } from 'react'
import { AccessibilityInfo, Alert, Platform } from 'react-native'
import * as Haptics from 'expo-haptics'

export type Choice = { text: string; style?: 'cancel' | 'destructive' | 'default'; onPress?: () => void }

/**
 * A native action sheet, or the nearest thing a browser has. React Native Web
 * ships no Alert, so the web build (the smoke test, mostly) gets a numbered
 * prompt; an empty answer is cancel.
 */
export function choose(title: string, message: string, buttons: Choice[]) {
  if (Platform.OS !== 'web') return Alert.alert(title, message, buttons)
  const actions = buttons.filter((b) => b.style !== 'cancel')
  const answer = window.prompt(`${title}\n${message}\n\n${actions.map((b, i) => `${i + 1}. ${b.text}`).join('\n')}`, '1')
  actions[Number(answer) - 1]?.onPress?.()
}

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/**
 * Reduced motion, watched. Every transition in the app multiplies its duration
 * by zero when this is true (6.1A): the tint snaps, the reader does not fade in,
 * the toast appears where it lands.
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    let alive = true
    void AccessibilityInfo.isReduceMotionEnabled().then((on) => {
      if (alive) setReduced(on)
    })
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced)
    return () => {
      alive = false
      sub.remove()
    }
  }, [])
  return reduced
}

/** ms, or 0 when the user has asked for less motion. */
export const motion = (ms: number, reduced: boolean) => (reduced ? 0 : ms)

/**
 * Say a state change out loud to a screen reader — "Listening", "Paused". Never
 * the interim transcript: those words change several times a second and would
 * talk over the user (6.1A).
 */
export function announce(text: string) {
  if (text) AccessibilityInfo.announceForAccessibility(text)
}

/** The small tick under a highlight, or a command landing. Silent on the web. */
export function tick() {
  if (Platform.OS === 'web') return
  void Haptics.selectionAsync().catch(() => {})
}
