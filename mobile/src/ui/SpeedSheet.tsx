// How fast it reads. Five speeds, plus whatever the agent set if it asked for
// something else ("read it a bit quicker" lands on 1.75×) — the pill in the
// header always shows the truth, so the sheet has to be able to (1.2A).
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { tts } from '../providers'
import { useStore } from '../store'
import { radius, space, type as type_, useTheme, type Theme } from '../theme'
import { COLUMN_MAX_WIDTH } from './layout'

const SPEEDS = [0.8, 1, 1.2, 1.5, 2]

/** "1.0×", "1.2×", "1.75×" — the pill and the sheet's rows say the same thing. */
export const speedLabel = (rate: number) => `${Number.isInteger(rate) ? rate.toFixed(1) : String(rate)}×`

export function SpeedSheet({ onClose }: { onClose: () => void }) {
  const theme = useTheme()
  const s = styles(theme)
  const insets = useSafeAreaInsets()
  const rate = useStore((st) => st.rate)
  const options = SPEEDS.includes(rate) ? SPEEDS : [...SPEEDS, rate].sort((a, b) => a - b)

  // Both halves, exactly as agent.ts's set_speed tool does it: the store for the
  // UI, the player for the next paragraph.
  const pick = (next: number) => {
    useStore.getState().setRate(next)
    tts.setRate(next)
    onClose()
  }

  return (
    <Modal transparent animationType="slide" visible onRequestClose={onClose}>
      <Pressable style={s.backdrop} accessibilityLabel="Close" onPress={onClose} />
      <View style={[s.sheet, { paddingBottom: insets.bottom + space.lg }]}>
        <Text style={s.title} accessibilityRole="header">Speed</Text>
        {options.map((option) => (
          <Pressable
            key={option}
            role="button"
            accessibilityLabel={`Speed, ${speedLabel(option)}`}
            accessibilityState={{ selected: option === rate }}
            style={s.row}
            onPress={() => pick(option)}
          >
            <Text style={[s.rowText, option === rate && s.rowTextOn]}>{speedLabel(option)}</Text>
            {option === rate && <Text style={s.check}>✓</Text>}
          </Pressable>
        ))}
      </View>
    </Modal>
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
    backdrop: { flex: 1 },
    sheet: {
      backgroundColor: theme.surface,
      borderTopLeftRadius: radius.card,
      borderTopRightRadius: radius.card,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.hairline,
      paddingHorizontal: space.lg,
      paddingTop: space.lg,
      width: '100%',
      maxWidth: COLUMN_MAX_WIDTH,
      alignSelf: 'center',
    },
    title: { ...type_.ui, fontWeight: '600', color: theme.textPrimary, marginBottom: space.sm },
    row: {
      minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.hairline,
    },
    rowText: { ...type_.ui, color: theme.textSecondary },
    rowTextOn: { color: theme.textPrimary, fontWeight: '600' },
    check: { ...type_.ui, color: theme.accent },
  })
}
