// The reader: a header, the book, and the Composer. Four rows of chrome came
// off the bottom (S4) — the speed and the highlight count are pills in the
// header (1.2A), filing moved into the transcript, and everything else the
// footer used to say is the Composer's one line.
import { useCallback, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { closeDocument, highlightParagraph, removeHighlight } from '../session'
import { useStore } from '../store'
import { radius, space, type as type_, useTheme, type Theme } from '../theme'
import type { Highlight } from '../types'
import { BackToVoicePill } from './BackToVoicePill'
import { Composer } from './Composer'
import { choose, errorText, tick } from './kit'
import { NoteSheet } from './NoteSheet'
import { ReaderList, type ReaderListHandle } from './ReaderList'
import { SpeedSheet, speedLabel } from './SpeedSheet'

export function ReaderScreen() {
  const theme = useTheme()
  const s = styles(theme)
  const insets = useSafeAreaInsets()
  const doc = useStore((st) => st.doc)
  const rate = useStore((st) => st.rate)
  const playing = useStore((st) => st.playing)
  const marks = useStore((st) => st.highlights.filter((h) => h.anchor && h.pending !== 'delete').length)
  const hasText = useStore((st) => st.paragraphs.length > 0)

  const list = useRef<ReaderListHandle>(null)
  const [note, setNote] = useState<Highlight | null>(null)
  const [speed, setSpeed] = useState(false)
  const [lost, setLost] = useState(false)

  // A long-press repaints the paragraph under the finger; the release then lands
  // on the fresh highlight and would open its sheet. Ignore mark taps for a beat.
  const suppressMarksUntil = useRef(0)

  const askHighlight = useCallback((index: number) => {
    const p = useStore.getState().paragraphs[index]
    if (!p) return
    suppressMarksUntil.current = Date.now() + 800
    choose('Highlight this paragraph?', p.text.slice(0, 120) + (p.text.length > 120 ? '…' : ''), [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Highlight',
        onPress: () => {
          void highlightParagraph(index)
            .then(tick) // the mark landed, under your finger
            .catch((e: unknown) => useStore.getState().setNotice(errorText(e)))
        },
      },
    ])
  }, [])

  const askMark = useCallback((h: Highlight) => {
    if (Date.now() < suppressMarksUntil.current) return
    choose(h.note ? h.note : 'Highlight', h.text.slice(0, 120), [
      { text: h.note ? 'Edit note' : 'Add note', onPress: () => setNote(h) },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: () => void removeHighlight(h.id).catch((e: unknown) => useStore.getState().setNotice(errorText(e))),
      },
      { text: 'Cancel', style: 'cancel' },
    ])
  }, [])

  return (
    <View style={s.screen}>
      <View style={[s.header, { paddingTop: insets.top + space.md }]}>
        <Pressable role="button" accessibilityLabel="Back to library" style={s.back} onPress={() => void closeDocument()}>
          <Text style={s.link}>‹ Library</Text>
        </Pressable>
        <Text style={s.title} numberOfLines={1}>{doc?.title}</Text>
        {marks > 0 && (
          <Pressable
            role="button"
            accessibilityLabel={marks === 1 ? '1 highlight' : `${marks} highlights`}
            style={s.pill}
            onPress={() => list.current?.jumpToNextHighlight()}
          >
            <Text style={s.pillText}>{marks === 1 ? '1 highlight' : `${marks} highlights`}</Text>
          </Pressable>
        )}
        <Pressable
          role="button"
          accessibilityLabel={`Speed, ${speedLabel(rate)}`}
          style={s.pill}
          onPress={() => setSpeed(true)}
          testID="speed-pill"
        >
          <Text style={s.pillText}>{speedLabel(rate)}</Text>
        </Pressable>
      </View>

      {doc && !hasText ? (
        <View style={s.empty}>
          <Text style={s.emptyText}>No readable text in this document.</Text>
        </View>
      ) : (
        <ReaderList
          key={doc?.id}
          ref={list}
          onLongPressParagraph={askHighlight}
          onPressMark={askMark}
          onLostChange={setLost}
        />
      )}

      {lost && playing && <BackToVoicePill onPress={() => list.current?.followTheVoice()} />}
      <Composer reader />
      {note && <NoteSheet highlight={note} onClose={() => setNote(null)} />}
      {speed && <SpeedSheet onClose={() => setSpeed(false)} />}
    </View>
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
    screen: { flex: 1 },
    header: {
      flexDirection: 'row', alignItems: 'center', gap: space.sm,
      paddingHorizontal: space.lg, paddingBottom: space.md,
      borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.hairline,
    },
    back: { minHeight: 44, justifyContent: 'center' },
    link: { ...type_.ui, color: theme.accent, fontWeight: '600' },
    title: { ...type_.ui, fontWeight: '600', color: theme.textPrimary, flex: 1, textAlign: 'center' },
    pill: {
      minHeight: 44, justifyContent: 'center', paddingHorizontal: space.md,
      borderRadius: radius.pill, backgroundColor: theme.surfaceSecondary,
    },
    pillText: { ...type_.meta, color: theme.accent, fontWeight: '600' },
    empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl },
    emptyText: { ...type_.ui, color: theme.textTertiary },
  })
}
