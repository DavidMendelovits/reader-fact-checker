// The conversation, when you want it. The Composer shows one line; this is the
// last thirty, plus — when a document is open — the one control that used to
// live in the reader's header: what shelf it is filed on (1.2A).
import { useEffect, useRef } from 'react'
import {
  AccessibilityInfo, findNodeHandle, Modal, PanResponder, Platform, Pressable, ScrollView,
  StyleSheet, Text, View,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { moveDocument } from '../session'
import { useStore } from '../store'
import { radius, space, type as type_, useTheme, type Theme } from '../theme'
import type { Location } from '../types'
import { choose, errorText } from './kit'
import { COLUMN_MAX_WIDTH } from './layout'

const LOCATION_LABEL: Record<Location, string> = { new: 'Inbox', later: 'Later', archive: 'Archive', feed: 'Feed' }
const SHELVES: Location[] = ['new', 'later', 'archive']

/** How far the handle has to travel before the sheet lets go. */
const DISMISS_DISTANCE = 80
const LINES = 30

export function TranscriptSheet({ onClose }: { onClose: () => void }) {
  const theme = useTheme()
  const s = styles(theme)
  const insets = useSafeAreaInsets()
  const chat = useStore((st) => st.chat)
  const libraryDoc = useStore((st) => st.libraryDoc)
  const title = useRef<Text>(null)

  // VoiceOver lands inside the sheet rather than staying on the bar behind it.
  // The web has no node handles; a browser's own focus order is enough there.
  useEffect(() => {
    if (Platform.OS === 'web') return
    const t = setTimeout(() => {
      const tag = findNodeHandle(title.current)
      if (tag) AccessibilityInfo.setAccessibilityFocus(tag)
    }, 150)
    return () => clearTimeout(t)
  }, [])

  const drag = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => g.dy > 4,
      onPanResponderRelease: (_, g) => {
        if (g.dy > DISMISS_DISTANCE) onClose()
      },
    }),
  ).current

  const file = () => {
    if (!libraryDoc) return
    const id = libraryDoc.id
    const move = (to: Location) => () =>
      void moveDocument(id, to).catch((e: unknown) => useStore.getState().setNotice(errorText(e)))
    choose('File under', `Now in ${LOCATION_LABEL[libraryDoc.location]}.`, [
      ...SHELVES.filter((t) => t !== libraryDoc.location).map((t) => ({ text: LOCATION_LABEL[t], onPress: move(t) })),
      { text: 'Cancel', style: 'cancel' as const },
    ])
  }

  const lines = chat.slice(-LINES)

  return (
    <Modal transparent animationType="slide" visible onRequestClose={onClose}>
      <Pressable style={s.backdrop} accessibilityLabel="Close the transcript" onPress={onClose} />
      <View style={[s.sheet, { paddingBottom: insets.bottom + space.lg }]}>
        <View style={s.grabArea} {...drag.panHandlers}>
          <View style={s.grab} />
        </View>
        <View style={s.headerRow}>
          <Text ref={title} style={s.title} accessibilityRole="header">Transcript</Text>
          {libraryDoc && (
            <Pressable role="button" accessibilityLabel={`Filed in ${LOCATION_LABEL[libraryDoc.location]}. Move it.`} style={s.pill} onPress={file}>
              <Text style={s.pillText}>{LOCATION_LABEL[libraryDoc.location]} ▾</Text>
            </Pressable>
          )}
          <Pressable role="button" accessibilityLabel="Close the transcript" style={s.close} onPress={onClose}>
            <Text style={s.closeGlyph}>✕</Text>
          </Pressable>
        </View>
        <ScrollView style={s.log} contentContainerStyle={s.logContent} keyboardShouldPersistTaps="always">
          {lines.length === 0 ? (
            <Text style={s.empty}>Nothing said yet.</Text>
          ) : (
            lines.map((m) => (
              <Text key={m.id} style={m.role === 'user' ? s.you : s.them}>
                {m.role === 'user' ? 'You: ' : ''}{m.text}
              </Text>
            ))
          )}
        </ScrollView>
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
      maxHeight: '70%',
      width: '100%',
      maxWidth: COLUMN_MAX_WIDTH,
      alignSelf: 'center',
    },
    grabArea: { height: 28, alignItems: 'center', justifyContent: 'center' },
    grab: { width: 36, height: 4, borderRadius: radius.pill, backgroundColor: theme.hairline },
    headerRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
    title: { ...type_.ui, fontWeight: '600', color: theme.textPrimary, flex: 1 },
    pill: {
      minHeight: 44, justifyContent: 'center', paddingHorizontal: space.md,
      borderRadius: radius.pill, backgroundColor: theme.surfaceSecondary,
    },
    pillText: { ...type_.meta, color: theme.accent, fontWeight: '600' },
    close: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
    closeGlyph: { fontSize: 18, color: theme.accent },
    log: { marginTop: space.sm },
    logContent: { gap: space.md, paddingVertical: space.md },
    you: { ...type_.ui, color: theme.textSecondary },
    them: { ...type_.ui, color: theme.textPrimary },
    empty: { ...type_.ui, color: theme.textTertiary },
  })
}
