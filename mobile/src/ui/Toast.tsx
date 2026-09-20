// The one interruption the app allows itself. It used to sit at the bottom, on
// top of the type bar, and never went away (K5). Now it slides in under the
// header: news disappears by itself, trouble waits to be acknowledged.
import { useEffect, useRef } from 'react'
import { Animated, Pressable, StyleSheet, Text } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useStore } from '../store'
import { radius, space, type as type_, useTheme, type Theme } from '../theme'
import { motion, useReducedMotion } from './kit'
import { COLUMN_MAX_WIDTH } from './layout'

const DISMISS_AFTER = 6000

/** The header's height (12 + 44 + 12): the toast lands under it, never over it. */
const UNDER_THE_HEADER = 68

/**
 * Trouble, or news?
 *
 * ponytail: `notice` is one string, so this reads it rather than carrying a
 * severity through every call site. Give the store a typed notice the day a
 * message is misfiled.
 */
const isError = /couldn't|could not|failed|unavailable|no readable|denied|error/i

export function Toast() {
  const theme = useTheme()
  const s = styles(theme)
  const insets = useSafeAreaInsets()
  const reduced = useReducedMotion()
  const notice = useStore((st) => st.notice)
  const slide = useRef(new Animated.Value(0)).current

  useEffect(() => {
    if (!notice) return
    slide.setValue(0)
    Animated.timing(slide, { toValue: 1, duration: motion(200, reduced), useNativeDriver: true }).start()
    if (isError.test(notice)) return
    const t = setTimeout(() => useStore.getState().setNotice(null), DISMISS_AFTER)
    return () => clearTimeout(t)
  }, [notice, reduced, slide])

  if (!notice) return null
  const style = {
    opacity: slide,
    transform: [{ translateY: slide.interpolate({ inputRange: [0, 1], outputRange: [-12, 0] }) }],
  }
  return (
    <Animated.View style={[s.wrap, { top: insets.top + UNDER_THE_HEADER + space.sm }, style]} pointerEvents="box-none">
      <Pressable role="button" accessibilityLabel={`${notice}. Tap to dismiss.`} style={s.toast} onPress={() => useStore.getState().setNotice(null)}>
        <Text style={s.text}>{notice}</Text>
      </Pressable>
    </Animated.View>
  )
}

const cache = new WeakMap<Theme, ReturnType<typeof build>>()
function styles(theme: Theme) {
  let s = cache.get(theme)
  if (!s) {
    s = build(theme)
    cache.set(theme, s)
  }
  return s
}

function build(theme: Theme) {
  return StyleSheet.create({
    wrap: {
      position: 'absolute', left: space.lg, right: space.lg,
      maxWidth: COLUMN_MAX_WIDTH, alignSelf: 'center',
    },
    toast: {
      backgroundColor: theme.textPrimary, borderRadius: radius.card,
      padding: space.md, minHeight: 44, justifyContent: 'center',
    },
    text: { ...type_.ui, color: theme.canvas },
  })
}
