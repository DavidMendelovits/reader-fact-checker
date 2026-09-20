// Scrolling away from the narration used to be a fight: every paragraph change
// yanked the list back (S5). Now a drag stops the following and this appears —
// the one way back, and the only thing on screen that moves while you read.
import { Pressable, StyleSheet, Text } from 'react-native'
import { space, radius, type as type_, useTheme, type Theme } from '../theme'
import { BACK_TO_VOICE_RESERVE, useBottomInset } from './useBottomInset'

export function BackToVoicePill({ onPress }: { onPress: () => void }) {
  const theme = useTheme()
  const s = styles(theme)
  // The pill sits in the room the bottom inset already reserves for it.
  const bottom = useBottomInset() - BACK_TO_VOICE_RESERVE + space.sm
  return (
    <Pressable
      role="button"
      accessibilityLabel="Back to the voice"
      style={[s.pill, { bottom }]}
      onPress={onPress}
      testID="back-to-voice"
    >
      <Text style={s.text}>↓ Back to the voice</Text>
    </Pressable>
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
    pill: {
      position: 'absolute', alignSelf: 'center',
      minHeight: 44, justifyContent: 'center',
      paddingHorizontal: space.lg,
      borderRadius: radius.pill,
      backgroundColor: theme.textPrimary,
    },
    text: { ...type_.meta, color: theme.canvas, fontWeight: '600' },
  })
}
