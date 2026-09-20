// The book itself, and nothing else.
//
// This is the half of the reader that must not re-render: it subscribes to the
// paragraphs, the position and the highlights, and to nothing the conversation
// touches (L1). Its handlers are stable and unmarked rows share one array, so
// the row memo actually holds (L2) and a paragraph change commits two rows.
//
// It also owns the two things that used to make opening a book feel slow: the
// bookmark (estimated offsets, one silent correction, a 120ms fade — X3) and
// following the voice (paused by a drag, resumed by the pill or by scrolling
// the voice back into view — S5).
import {
  forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState,
} from 'react'
import {
  Animated, FlatList, PixelRatio, Pressable, StyleSheet, Text, useWindowDimensions,
  type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent,
} from 'react-native'
import { splitRuns } from '../highlights'
import { useStore } from '../store'
import { space, type as type_, useTheme, type Theme } from '../theme'
import type { FlatParagraph, Highlight } from '../types'
import { motion, useReducedMotion } from './kit'
import { COLUMN_MAX_WIDTH, estimateHeight, heightAt, offsetsFrom } from './layout'
import { useBottomInset } from './useBottomInset'

/** A highlight's span in one paragraph, in the shape splitRuns wants. */
interface Mark {
  start: number
  end: number
  h: Highlight
}

/** One array for every unmarked paragraph: a fresh `[]` per row broke the memo. */
const NO_MARKS: Mark[] = []

/** Where in the window the voice sits when the list follows it. */
const VIEW_POSITION = 0.3

/** Reveal the list anyway after this long, even if nothing has measured (X3). */
const REVEAL_CAP_MS = 400

/** How long one of our own animated scrolls is given to land. */
const SETTLE_MS = 600

/** Reading text grows with the OS text size, but only this far (6.1A). */
const MAX_FONT_SCALE = 1.5

export interface ReaderListHandle {
  /** The header's highlight pill: the next mark after the voice, wrapping round. */
  jumpToNextHighlight: () => void
  /** The pill: follow again, from wherever the voice has got to. */
  followTheVoice: () => void
}

interface Props {
  onLongPressParagraph: (index: number) => void
  onPressMark: (h: Highlight) => void
  /** True when the voice is off screen and the list is not following it. */
  onLostChange: (lost: boolean) => void
}

export const ReaderList = forwardRef<ReaderListHandle, Props>(function ReaderList(
  { onLongPressParagraph, onPressMark, onLostChange },
  ref,
) {
  const theme = useTheme()
  const reduced = useReducedMotion()
  const paragraphs = useStore((s) => s.paragraphs)
  const current = useStore((s) => s.currentParagraph)
  const highlights = useStore((s) => s.highlights)
  const bottomInset = useBottomInset()
  const { width } = useWindowDimensions()
  const column = Math.min(width, COLUMN_MAX_WIDTH)
  const fontScale = Math.min(PixelRatio.getFontScale(), MAX_FONT_SCALE)

  const list = useRef<FlatList<FlatParagraph>>(null)
  const viewport = useRef(0)
  const scrollY = useRef(0)
  const following = useRef(true)
  const lost = useRef(false)
  const currentRef = useRef(current)
  currentRef.current = current
  const reducedRef = useRef(reduced)
  reducedRef.current = reduced

  // ---- where every row sits ----
  const estimates = useMemo(
    () => paragraphs.map((p) => estimateHeight(p.text, column, p.paragraphIndex === 0, fontScale)),
    [paragraphs, column, fontScale],
  )
  const estimatesRef = useRef(estimates)
  estimatesRef.current = estimates
  const measured = useRef(new Map<number, number>())
  const offsets = useRef<number[]>(offsetsFrom(estimates, measured.current))
  // A rotation or a text-size change invalidates every measurement.
  useEffect(() => {
    measured.current.clear()
    offsets.current = offsetsFrom(estimatesRef.current, measured.current)
  }, [column, fontScale])

  // ---- the bookmark ----
  const start = useRef(current).current
  const [placed, setPlaced] = useState(false)
  const placedRef = useRef(false)
  const opacity = useRef(new Animated.Value(0)).current

  const reveal = useCallback(() => {
    if (placedRef.current) return
    placedRef.current = true
    setPlaced(true)
    Animated.timing(opacity, {
      toValue: 1,
      duration: motion(120, reducedRef.current),
      useNativeDriver: true,
    }).start()
  }, [opacity])

  // One non-animated correction from the measured row, then the fade. If nothing
  // has measured by the cap the list is shown anyway: a slightly wrong position
  // beats a blank screen.
  const place = useCallback(() => {
    if (placedRef.current) return
    if (viewport.current === 0 || !measured.current.has(start)) return
    const offset = Math.max(0, offsets.current[start] - VIEW_POSITION * viewport.current)
    list.current?.scrollToOffset({ offset, animated: false })
    scrollY.current = offset
    reveal()
  }, [start, reveal])

  useEffect(() => {
    const t = setTimeout(reveal, REVEAL_CAP_MS)
    return () => clearTimeout(t)
  }, [reveal])

  // Measurements arrive one row at a time; the table is rebuilt once per batch.
  const rebuild = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onMeasure = useCallback((index: number, height: number) => {
    const previous = measured.current.get(index)
    if (previous !== undefined && Math.abs(previous - height) < 0.5) return
    measured.current.set(index, height)
    if (rebuild.current) return
    rebuild.current = setTimeout(() => {
      rebuild.current = null
      offsets.current = offsetsFrom(estimatesRef.current, measured.current)
      place()
    }, 0)
  }, [place])

  // ---- following the voice ----
  // While one of our own scrolls is still travelling, the current row passes in
  // and out of view; nothing is decided until it has landed.
  const settleUntil = useRef(0)

  const publish = useCallback((next: boolean) => {
    if (next === lost.current) return
    lost.current = next
    onLostChange(next)
  }, [onLostChange])

  // Following is simply "the voice is on screen". A drag says otherwise first
  // (below), so the list is never yanked out from under a finger; here, the
  // voice walking off the screen on its own is what raises the pill.
  const report = useCallback(() => {
    if (Date.now() < settleUntil.current) return
    const index = currentRef.current
    const top = offsets.current[index] ?? 0
    const inView = top + heightAt(offsets.current, index) > scrollY.current
      && top < scrollY.current + viewport.current
    following.current = inView
    publish(!inView)
  }, [publish])

  // A programmatic scroll ends without another scroll event, so the verdict is
  // taken once it has had time to land.
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reportWhenLanded = useCallback(() => {
    if (settle.current) clearTimeout(settle.current)
    settle.current = setTimeout(report, SETTLE_MS + 50)
  }, [report])

  useEffect(() => () => {
    if (rebuild.current) clearTimeout(rebuild.current)
    if (settle.current) clearTimeout(settle.current)
  }, [])

  const goToCurrent = useCallback(() => {
    const index = currentRef.current
    const height = viewport.current || 1
    const offset = Math.max(0, (offsets.current[index] ?? 0) - VIEW_POSITION * height)
    // Within a screen it is a scroll; further than that it is a jump, and
    // watching the list race through a chapter helps nobody (X3).
    const near = Math.abs(offset - scrollY.current) <= height
    const animated = near && !reducedRef.current
    settleUntil.current = Date.now() + (animated ? SETTLE_MS : 0)
    list.current?.scrollToOffset({ offset, animated })
    reportWhenLanded()
  }, [reportWhenLanded])

  useEffect(() => {
    if (!placedRef.current) return
    if (following.current) goToCurrent()
    else report()
  }, [current, goToCurrent, report])

  // ---- highlights ----
  const painted = useMemo(
    () => highlights.filter((h) => h.anchor && h.pending !== 'delete'),
    [highlights],
  )
  const marksByParagraph = useMemo(() => {
    const m = new Map<number, Mark[]>()
    for (const h of painted) {
      const a = h.anchor!
      const arr = m.get(a.paragraph) ?? []
      arr.push({ start: a.start, end: a.end, h })
      m.set(a.paragraph, arr)
    }
    return m
  }, [painted])

  useImperativeHandle(ref, () => ({
    followTheVoice() {
      following.current = true
      goToCurrent()
      publish(false)
    },
    jumpToNextHighlight() {
      const at = [...new Set(painted.map((h) => h.anchor!.paragraph))].sort((a, b) => a - b)
      if (at.length === 0) return
      const next = at.find((i) => i > currentRef.current) ?? at[0]
      const offset = Math.max(0, (offsets.current[next] ?? 0) - VIEW_POSITION * (viewport.current || 1))
      following.current = false
      settleUntil.current = Date.now() + SETTLE_MS
      list.current?.scrollToOffset({ offset, animated: !reducedRef.current })
      reportWhenLanded()
    },
  }), [painted, goToCurrent, publish, reportWhenLanded])

  // ---- the list ----
  const getItemLayout = useCallback(
    (_: unknown, index: number) => ({
      length: heightAt(offsets.current, index),
      offset: offsets.current[index] ?? 0,
      index,
    }),
    [],
  )

  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    scrollY.current = e.nativeEvent.contentOffset.y
    report()
  }, [report])

  const onLayout = useCallback((e: LayoutChangeEvent) => {
    viewport.current = e.nativeEvent.layout.height
    place()
  }, [place])

  const onScrollBeginDrag = useCallback(() => {
    // A drag stops the following at once, before the voice has left the screen:
    // the list must not be yanked back under a moving finger (S5).
    settleUntil.current = 0
    following.current = false
    report()
  }, [report])

  const renderItem = useCallback(
    ({ item, index }: { item: FlatParagraph; index: number }) => (
      <ParagraphRow
        item={item}
        index={index}
        current={index === currentRef.current}
        marks={marksByParagraph.get(index) ?? NO_MARKS}
        theme={theme}
        reduced={reduced}
        onLongPress={onLongPressParagraph}
        onPressMark={onPressMark}
        onMeasure={onMeasure}
      />
    ),
    [marksByParagraph, theme, reduced, onLongPressParagraph, onPressMark, onMeasure],
  )

  const content = useMemo(
    () => [contentStyle, { paddingBottom: bottomInset }],
    [bottomInset],
  )

  return (
    <Animated.View style={[fill, { opacity: placed ? opacity : 0 }]} onLayout={onLayout}>
      <FlatList
        ref={list}
        data={paragraphs}
        keyExtractor={keyOf}
        renderItem={renderItem}
        extraData={current}
        getItemLayout={getItemLayout}
        initialScrollIndex={start < paragraphs.length ? start : undefined}
        onScrollToIndexFailed={() => reveal()}
        onScroll={onScroll}
        scrollEventThrottle={16}
        onScrollBeginDrag={onScrollBeginDrag}
        keyboardShouldPersistTaps="always"
        contentContainerStyle={content}
      />
    </Animated.View>
  )
})

const keyOf = (_: FlatParagraph, i: number) => String(i)
const fill = { flex: 1 } as const
const contentStyle = {
  width: '100%', maxWidth: COLUMN_MAX_WIDTH, alignSelf: 'center',
} as const

interface RowProps {
  item: FlatParagraph
  index: number
  current: boolean
  marks: Mark[]
  theme: Theme
  reduced: boolean
  onLongPress: (index: number) => void
  onPressMark: (h: Highlight) => void
  onMeasure: (index: number, height: number) => void
}

const ParagraphRow = memo(function ParagraphRow({
  item, index, current, marks, theme, reduced, onLongPress, onPressMark, onMeasure,
}: RowProps) {
  const s = styles(theme)
  const runs = splitRuns(item.text, marks)
  const heading = item.paragraphIndex === 0

  // The playhead fades in rather than snapping between paragraphs.
  const tint = useRef(new Animated.Value(current ? 1 : 0)).current
  useEffect(() => {
    Animated.timing(tint, {
      toValue: current ? 1 : 0,
      duration: motion(150, reduced),
      useNativeDriver: false,
    }).start()
  }, [current, reduced, tint])
  const backgroundColor = tint.interpolate({
    inputRange: [0, 1],
    outputRange: [theme.canvas, theme.currentWash],
  })

  const measure = useCallback(
    (e: LayoutChangeEvent) => onMeasure(index, e.nativeEvent.layout.height),
    [index, onMeasure],
  )

  // A Pressable, not Text handlers: long-press behaves the same on iOS, Android
  // and the web build, and screen readers get a real element to land on.
  return (
    <Pressable
      role="button"
      accessibilityLabel={`${heading ? 'Chapter heading' : 'Paragraph'} ${index + 1}. Long press to highlight.`}
      onLongPress={() => onLongPress(index)}
      delayLongPress={450}
      onLayout={measure}
    >
      <Animated.View style={[s.row, { backgroundColor }]}>
        <Text
          style={[s.paragraph, heading && s.heading]}
          maxFontSizeMultiplier={MAX_FONT_SCALE}
        >
          {runs.map((r, i) =>
            r.mark ? (
              <Text
                key={i}
                style={[s.mark, r.mark.h.pending === 'create' && s.markPending]}
                onPress={() => onPressMark(r.mark!.h)}
              >
                {r.text}
                {r.mark.h.note ? <Text style={s.markNote}> ✎</Text> : null}
              </Text>
            ) : (
              <Text key={i}>{r.text}</Text>
            ),
          )}
        </Text>
      </Animated.View>
    </Pressable>
  )
})

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
    row: { paddingHorizontal: space.xl, paddingVertical: space.sm },
    paragraph: { fontFamily: type_.readingFamily, ...type_.body, color: theme.textSecondary },
    heading: {
      ...type_.heading, color: theme.textPrimary,
      paddingTop: space.xxl, paddingBottom: space.xxl,
    },
    mark: { backgroundColor: theme.highlight, color: theme.textPrimary },
    markPending: { backgroundColor: theme.highlightWash },
    markNote: { color: theme.accent, ...type_.meta },
  })
}
