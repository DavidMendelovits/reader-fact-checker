// One bar, every signed-in screen: mic · line · play/pause · transcript · keyboard.
//
// Before this there were three text boxes and four places that claimed to say
// what the app was doing, and they disagreed. Now there is one line (its
// priority lives in shared/voice/line.ts, so the web says the same thing) and
// one mic — which is also the mute (1.2A). The bar rides the keyboard rather
// than hiding under it.
import { memo, useCallback, useEffect, useRef, useState } from 'react'
import {
  Animated, Linking, Platform, Pressable, StyleSheet, Text, TextInput, View,
} from 'react-native'
import { KeyboardStickyView } from 'react-native-keyboard-controller'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { lineFor } from '../../../shared/voice/line'
import { pause, play, say, setMicEnabled } from '../agent'
import { voice } from '../providers'
import { radius, space, type as type_, useTheme, type Theme } from '../theme'
import { useStore, type MicState } from '../store'
import { announce, motion, tick, useReducedMotion } from './kit'
import { COLUMN_MAX_WIDTH } from './layout'
import { TranscriptSheet } from './TranscriptSheet'
import { setComposerHeight } from './useBottomInset'

/** The bar's own height, before the safe-area inset under it (1.1A). */
const BAR = 60
const TARGET = 44

const AGENT_ANNOUNCEMENT: Record<string, string> = {
  listening: 'Listening',
  thinking: 'Thinking',
  reading: 'Reading',
  speaking: 'Speaking',
}

const MIC_LABEL: Record<MicState, string> = {
  notAsked: 'Microphone, off',
  live: 'Microphone, on',
  muted: 'Microphone, muted',
  denied: 'Microphone, blocked',
  off: 'Microphone, off',
}

/** The chat lines a fast command leaves behind; landing one is worth a tick. */
const FAST_COMMAND_LINE = /^(Paused|Reading)\.$/

export function Composer({ reader = false }: { reader?: boolean }) {
  const theme = useTheme()
  const reduced = useReducedMotion()
  const insets = useSafeAreaInsets()
  const s = styles(theme)

  const interim = useStore((st) => st.interim)
  const agentState = useStore((st) => st.agentState)
  const playing = useStore((st) => st.playing)
  const lastAgentLine = useStore((st) => st.lastAgentLine)
  const lastAgentLineAt = useStore((st) => st.lastAgentLineAt)
  const current = useStore((st) => st.currentParagraph)
  const total = useStore((st) => st.paragraphs.length)
  const micState = useStore((st) => st.micState)

  const [expanded, setExpanded] = useState(false)
  const [draft, setDraft] = useState('')
  const [transcript, setTranscript] = useState(false)

  // The agent's reply holds the line for three seconds and then stops; nothing
  // else changes at that moment, so the line needs a nudge to re-read itself.
  const [, redraw] = useState(0)
  useEffect(() => {
    if (lastAgentLineAt === null) return
    const left = lastAgentLineAt + 3000 - Date.now()
    if (left <= 0) return
    const t = setTimeout(() => redraw((n) => n + 1), left + 50)
    return () => clearTimeout(t)
  }, [lastAgentLineAt])

  // VoiceOver hears state changes only — never the interim words, which change
  // several times a second (6.1A).
  useEffect(() => {
    announce(AGENT_ANNOUNCEMENT[agentState] ?? '')
  }, [agentState])

  // A fast command landing is a tick under the thumb: the app heard you.
  useEffect(() => {
    if (lastAgentLine && FAST_COMMAND_LINE.test(lastAgentLine)) tick()
  }, [lastAgentLine, lastAgentLineAt])

  const line = lineFor({
    interim, agentState, playing, lastAgentLine, lastAgentLineAt,
    now: Date.now(), current, total, micState,
  })

  const openSettingsApp = () => {
    if (Platform.OS !== 'web') void Linking.openSettings()
  }

  const onMic = useCallback(() => {
    // Denied is not a toggle: only the OS can give the mic back.
    if (micState === 'denied') return openSettingsApp()
    const on = micState !== 'live'
    // The first tap is where the OS asks for the mic and for speech (3.1A);
    // agent.ts's setMicEnabled decides whether the agent says hello (once a day).
    useStore.getState().setMicState(on ? 'live' : 'muted')
    setMicEnabled(on)
  }, [micState])

  const onLine = useCallback(() => {
    if (micState === 'denied') return openSettingsApp()
    setTranscript(true)
  }, [micState])

  const send = useCallback(() => {
    const text = draft.trim()
    if (!text) return
    setDraft('')
    setExpanded(false)
    // dev only: ">words" plays the line through the ear's own handlers (speech
    // start, interim, final), so the voice path can be driven without a mic
    if (__DEV__ && text.startsWith('>')) {
      const spoken = text.slice(1).trim()
      voice.onSpeechStart()
      voice.onInterim(spoken)
      voice.onUtterance(spoken)
      return
    }
    say(text)
  }, [draft])

  const onLayout = useCallback((e: { nativeEvent: { layout: { height: number } } }) => {
    setComposerHeight(e.nativeEvent.layout.height)
  }, [])

  return (
    <>
      <KeyboardStickyView style={s.sticky} onLayout={onLayout}>
        <View style={[s.bar, { paddingBottom: insets.bottom }]}>
          <View style={[StyleSheet.absoluteFill, s.fill]} />
          <View style={s.row}>
            <MicButton state={micState} theme={theme} reduced={reduced} onPress={onMic} />
            {expanded ? (
              <>
                <TextInput
                  style={s.input}
                  value={draft}
                  onChangeText={setDraft}
                  onSubmitEditing={send}
                  placeholder="Type a message"
                  placeholderTextColor={theme.textTertiary}
                  returnKeyType="send"
                  blurOnSubmit={false}
                  autoFocus
                  accessibilityLabel="Type a message"
                  testID="composer-input"
                />
                <Control label="Send" glyph="↑" onPress={send} theme={theme} disabled={!draft.trim()} testID="composer-send" />
                <Control label="Close the keyboard" glyph="✕" onPress={() => setExpanded(false)} theme={theme} />
              </>
            ) : (
              <>
                <Pressable
                  style={s.lineArea}
                  role="button"
                  accessibilityLabel={line.text}
                  accessibilityHint="Opens the transcript"
                  onPress={onLine}
                  testID="composer-line"
                >
                  <Text style={[s.line, line.italic && s.lineItalic]} numberOfLines={1} maxFontSizeMultiplier={1.5}>
                    {line.text}
                  </Text>
                </Pressable>
                {reader && (
                  <Control
                    label={playing ? 'Pause' : 'Play'}
                    glyph={playing ? '❚❚' : '▶'}
                    onPress={() => (playing ? pause() : play())}
                    theme={theme}
                    testID="composer-play"
                  />
                )}
                <Control label="Transcript" glyph="☰" onPress={() => setTranscript(true)} theme={theme} testID="composer-transcript" />
                <Control label="Type a message" glyph="⌨" onPress={() => setExpanded(true)} theme={theme} testID="composer-keyboard" />
              </>
            )}
          </View>
        </View>
      </KeyboardStickyView>
      {transcript && <TranscriptSheet onClose={() => setTranscript(false)} />}
    </>
  )
}

function Control({
  label, glyph, onPress, theme, disabled, testID,
}: {
  label: string; glyph: string; onPress: () => void; theme: Theme; disabled?: boolean; testID?: string
}) {
  const s = styles(theme)
  return (
    <Pressable
      role="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      onPress={onPress}
      disabled={disabled}
      style={s.control}
      testID={testID}
    >
      <Text style={[s.glyph, disabled && s.dim]} maxFontSizeMultiplier={1.5}>{glyph}</Text>
    </Pressable>
  )
}

/**
 * The mic, drawn rather than set in a font: a capsule on a stand, filled when
 * the ear is open, outlined when it is not, struck through in red when the OS
 * has taken it away. It is the only mic control in the app (1.1A).
 */
const MicButton = memo(function MicButton({
  state, theme, reduced, onPress,
}: { state: MicState; theme: Theme; reduced: boolean; onPress: () => void }) {
  const s = styles(theme)
  const live = state === 'live'
  const denied = state === 'denied'
  const fade = useRef(new Animated.Value(live ? 1 : 0)).current
  useEffect(() => {
    Animated.timing(fade, {
      toValue: live ? 1 : 0,
      duration: motion(150, reduced),
      useNativeDriver: false,
    }).start()
  }, [live, reduced, fade])

  const background = fade.interpolate({
    inputRange: [0, 1],
    outputRange: [denied ? theme.canvas : theme.surfaceSecondary, theme.micLive],
  })
  const ink = live ? theme.canvas : denied ? theme.danger : theme.textSecondary

  return (
    <Pressable
      role="button"
      accessibilityLabel={MIC_LABEL[state]}
      onPress={onPress}
      style={s.control}
      testID="composer-mic"
    >
      <Animated.View style={[s.micCircle, { backgroundColor: background }, denied && s.micDenied]}>
        <View style={[s.micCapsule, { backgroundColor: ink }]} />
        <View style={[s.micStand, { borderColor: ink }]} />
        {denied && <View style={[s.micSlash, { backgroundColor: theme.danger }]} />}
      </Animated.View>
    </Pressable>
  )
})

const cache = new WeakMap<Theme, ReturnType<typeof build>>()
/** One StyleSheet per theme, built once: the themes are module constants. */
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
    sticky: { position: 'absolute', left: 0, right: 0, bottom: 0 },
    bar: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.hairline,
      paddingHorizontal: space.lg,
    },
    // Its own layer so the 96% is the paper's, not the text's: the aurora shows
    // through a little, the words never sit on it (4.1A guardrail).
    fill: { backgroundColor: theme.surface, opacity: 0.96 },
    row: {
      minHeight: BAR,
      width: '100%',
      maxWidth: COLUMN_MAX_WIDTH,
      alignSelf: 'center',
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.sm,
    },
    // minWidth 0: without it a flex child refuses to shrink past its content,
    // and on a 320pt phone the ✕ walks off the edge.
    lineArea: { flex: 1, minWidth: 0, height: TARGET, justifyContent: 'center' },
    line: { ...type_.ui, color: theme.textSecondary },
    lineItalic: { fontStyle: 'italic', color: theme.textPrimary },
    control: { width: TARGET, height: TARGET, alignItems: 'center', justifyContent: 'center' },
    glyph: { fontSize: 18, lineHeight: 22, color: theme.accent },
    dim: { opacity: 0.4 },
    input: {
      flex: 1,
      minWidth: 0,
      height: TARGET,
      paddingHorizontal: space.md,
      borderRadius: radius.input,
      backgroundColor: theme.surfaceSecondary,
      color: theme.textPrimary,
      // 16, not the UI 15: anything smaller and mobile Safari zooms on focus.
      fontSize: 16,
    },
    micCircle: {
      width: 36, height: 36, borderRadius: radius.pill,
      alignItems: 'center', justifyContent: 'center',
      borderWidth: 1, borderColor: theme.hairline,
    },
    micDenied: { borderColor: theme.danger },
    micCapsule: { width: 8, height: 13, borderRadius: radius.input, marginBottom: 1 },
    micStand: {
      width: 14, height: 7, borderWidth: 1.5, borderTopWidth: 0,
      borderBottomLeftRadius: radius.input, borderBottomRightRadius: radius.input,
      marginTop: -5,
    },
    micSlash: {
      position: 'absolute', width: 30, height: 2, borderRadius: radius.input,
      transform: [{ rotate: '-45deg' }],
    },
  })
}
