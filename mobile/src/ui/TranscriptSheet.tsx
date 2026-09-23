// The conversation, when you want it. The Composer shows one line; this is the
// last thirty, plus — when a document is open — the one control that used to
// live in the reader's header: what shelf it is filed on (1.2A).
//
// And the second tab: every fact check asked about this document, newest first.
// A check is the one thing the voice produces that is worth having in writing —
// a verdict spoken once, over a book, is gone — so it is kept with the document
// and tapping it takes the reader back to the passage it was about.
import { useEffect, useRef, useState } from 'react'
import {
  AccessibilityInfo, findNodeHandle, Modal, PanResponder, Platform, Pressable, ScrollView,
  StyleSheet, Text, View,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { COPY } from '../../../shared/voice/line'
import { moveDocument } from '../session'
import { useStore } from '../store'
import { radius, size, space, useTheme, weight, type as type_, type Theme } from '../theme'
import type { Check, Location } from '../types'
import { Glyph } from './Glyph'
import { choose, errorText } from './kit'
import { COLUMN_MAX_WIDTH } from './layout'

const LOCATION_LABEL: Record<Location, string> = { new: 'Inbox', later: 'Later', archive: 'Archive', feed: 'Feed' }
const SHELVES: Location[] = ['new', 'later', 'archive']

/** How far the handle has to travel before the sheet lets go. */
const DISMISS_DISTANCE = 80
const LINES = 30


type Tab = 'chat' | 'checks'
const TABS: { id: Tab; label: string }[] = [
  { id: 'chat', label: 'Conversation' },
  { id: 'checks', label: 'Checks' },
]

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * How long ago, in the few words a glance needs. Anything older than yesterday
 * is just "yesterday": a check from last week is still a check, and the date
 * would be more precision than the row is worth.
 */
export function relativeTime(at: number, now: number): string {
  const ago = Math.max(0, now - at)
  if (ago < MINUTE) return 'just now'
  if (ago < HOUR) return `${Math.floor(ago / MINUTE)} min ago`
  if (ago < DAY) return `${Math.floor(ago / HOUR)} h ago`
  return 'yesterday'
}

export function TranscriptSheet({ onClose }: { onClose: () => void }) {
  const theme = useTheme()
  const s = styles(theme)
  const insets = useSafeAreaInsets()
  const chat = useStore((st) => st.chat)
  const checks = useStore((st) => st.checks)
  const libraryDoc = useStore((st) => st.libraryDoc)
  const title = useRef<Text>(null)
  const [tab, setTab] = useState<Tab>('chat')

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
  // newest first: the check you just asked for is the one you came here to read
  const rows = [...checks].reverse()
  const now = Date.now()

  const goTo = (c: Check) => {
    if (c.anchor === null) return
    useStore.getState().requestJump(c.anchor)
    onClose()
  }

  return (
    <Modal transparent animationType="slide" visible onRequestClose={onClose}>
      <Pressable style={s.backdrop} accessibilityLabel="Close the transcript" onPress={onClose} />
      <View style={[s.sheet, { paddingBottom: insets.bottom + space.lg }]}>
        <View testID="transcript-grab" style={s.grabArea} {...drag.panHandlers}>
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
            <Glyph name="close" color={theme.accent} />
          </Pressable>
        </View>
        <View style={s.tabs}>
          {TABS.map((t) => (
            <Pressable
              key={t.id}
              testID={`transcript-tab-${t.id}`}
              accessibilityRole="tab"
              accessibilityLabel={t.label}
              accessibilityState={{ selected: t.id === tab }}
              style={[s.tab, t.id === tab && s.tabOn]}
              onPress={() => setTab(t.id)}
            >
              <Text style={[s.tabText, t.id === tab && s.tabTextOn]}>{t.label}</Text>
            </Pressable>
          ))}
        </View>
        {tab === 'chat' ? (
          <ScrollView style={s.log} contentContainerStyle={s.logContent} keyboardShouldPersistTaps="always">
            {lines.length === 0 ? (
              <Text style={s.empty}>{COPY.emptyTranscript}</Text>
            ) : (
              lines.map((m) => (
                <Text key={m.id} style={m.role === 'user' ? s.you : s.them}>
                  {m.role === 'user' ? 'You: ' : ''}{m.text}
                </Text>
              ))
            )}
          </ScrollView>
        ) : (
          <ScrollView style={s.log} contentContainerStyle={s.logContent} keyboardShouldPersistTaps="always">
            {rows.length === 0 ? (
              <Text style={s.empty}>{COPY.emptyChecks}</Text>
            ) : (
              rows.map((c) => (
                <Pressable
                  key={c.id}
                  testID="check-row"
                  role="button"
                  disabled={c.anchor === null}
                  accessibilityLabel={`${c.verdict}. ${c.claim}.${c.anchor === null ? '' : ' Go to the passage.'}`}
                  style={s.checkRow}
                  onPress={() => goTo(c)}
                >
                  <Text style={s.verdict}>{c.verdict}</Text>
                  <Text style={s.claim} numberOfLines={2}>{c.claim}</Text>
                  <Text style={s.when}>{relativeTime(c.createdAt, now)}</Text>
                </Pressable>
              ))
            )}
          </ScrollView>
        )}
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
    grabArea: { height: size.target, alignItems: 'center', justifyContent: 'center' },
    grab: { width: size.grabBarWidth, height: size.grabBarHeight, borderRadius: radius.pill, backgroundColor: theme.hairline },
    headerRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
    title: { ...type_.ui, fontWeight: weight.semibold, color: theme.textPrimary, flex: 1 },
    pill: {
      minHeight: size.target, justifyContent: 'center', paddingHorizontal: space.md,
      borderRadius: radius.pill, backgroundColor: theme.surfaceSecondary,
    },
    pillText: { ...type_.meta, color: theme.accent, fontWeight: weight.semibold },
    close: { width: size.target, height: size.target, alignItems: 'center', justifyContent: 'center' },
    tabs: {
      flexDirection: 'row', gap: space.xl, marginTop: space.sm,
      borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.hairline,
    },
    tab: { minHeight: size.target, justifyContent: 'center', borderBottomWidth: 2, borderBottomColor: 'transparent', marginBottom: -1 },
    tabOn: { borderBottomColor: theme.accent },
    tabText: { ...type_.ui, color: theme.textTertiary, fontWeight: weight.semibold },
    tabTextOn: { color: theme.textPrimary },
    checkRow: { gap: space.xs, paddingVertical: space.xs },
    verdict: { ...type_.ui, fontWeight: weight.semibold, color: theme.textPrimary },
    claim: { ...type_.meta, color: theme.textSecondary },
    when: { ...type_.meta, color: theme.textTertiary },
    log: { marginTop: space.sm },
    logContent: { gap: space.md, paddingVertical: space.md },
    you: { ...type_.ui, color: theme.textSecondary },
    them: { ...type_.ui, color: theme.textPrimary },
    empty: { ...type_.ui, color: theme.textTertiary },
  })
}
