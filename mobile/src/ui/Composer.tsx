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
import Svg, { Path } from 'react-native-svg'
import { KeyboardStickyView, useKeyboardState } from 'react-native-keyboard-controller'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { GLYPHS } from '../../../shared/voice/glyphs'
import { lineFor, MIC_LABEL, REPLY_HOLD_MS } from '../../../shared/voice/line'
import { pause, play, say, setMicEnabled } from '../agent'
import { voice } from '../providers'
import { radius, space, type as type_, useTheme, type Theme } from '../theme'
import { useStore, type MicState } from '../store'
import { Glyph, MIC_SLASH, type GlyphName } from './Glyph'
import { announce, motion, tick, useReducedMotion } from './kit'
import { COLUMN_MAX_WIDTH } from './layout'
import { TranscriptSheet } from './TranscriptSheet'
import { setComposerHeight } from './useBottomInset'

/** Where ">say this" works: development, and the smoke's silent-voice web build. */
const DRIVES_THE_EAR = __DEV__ || !!process.env.EXPO_PUBLIC_SILENT_VOICE

/** The bar's own height, before the safe-area inset under it (1.1A). */
const BAR = 60
const TARGET = 44

const AGENT_ANNOUNCEMENT: Record<string, string> = {
  listening: 'Listening',
  thinking: 'Thinking',
  reading: 'Reading',
  speaking: 'Speaking',
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
  const voiceLoading = useStore((st) => st.voiceLoading)

  // With the keyboard up the bar rides above it, so the home-indicator inset
  // under it is an empty strip — and useBottomInset counts it twice.
  const keyboardUp = useKeyboardState((st) => st.isVisible)

  const [expanded, setExpanded] = useState(false)
  const [draft, setDraft] = useState('')
  const [transcript, setTranscript] = useState(false)

  // The agent's reply holds the line for three seconds and then stops; nothing
  // else changes at that moment, so the line needs a nudge to re-read itself.
  const [, redraw] = useState(0)
  useEffect(() => {
    if (lastAgentLineAt === null) return
    const left = lastAgentLineAt + REPLY_HOLD_MS - Date.now()
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
    now: Date.now(), current, total, micState, voiceLoading,
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
    // ">words" plays the line through the ear's own handlers (speech start,
    // interim, final), so the voice path can be driven without a mic. Development
    // and the browser smoke only; a shipped build has neither flag, and the branch
    // is dead code the bundler drops.
    if (DRIVES_THE_EAR && text.startsWith('>')) {
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
        <View style={[s.bar, { paddingBottom: keyboardUp ? 0 : insets.bottom }]}>
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
                <Control label="Send" glyph="send" onPress={send} theme={theme} disabled={!draft.trim()} testID="composer-send" />
                <Control label="Close the keyboard" glyph="close" onPress={() => setExpanded(false)} theme={theme} />
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
                    glyph={playing ? 'pause' : 'play'}
                    onPress={() => (playing ? pause() : play())}
                    theme={theme}
                    testID="composer-play"
                  />
                )}
                <Control label="Transcript" glyph="bubble" onPress={() => setTranscript(true)} theme={theme} testID="composer-transcript" />
                <Control label="Type a message" glyph="keyboard" onPress={() => setExpanded(true)} theme={theme} testID="composer-keyboard" />
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
  label: string; glyph: GlyphName; onPress: () => void; theme: Theme; disabled?: boolean; testID?: string
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
      <View style={disabled ? s.dim : undefined}>
        <Glyph name={glyph} color={theme.accent} />
      </View>
    </Pressable>
  )
}

/**
 * The mic, drawn rather than set in a font: the shared `mic` glyph, inked with
 * the state's colour inside a circle that fades to green while the ear is open,
 * struck through in red when the OS has taken it away. The only mic in the app (1.1A).
 */
const MicButton = memo(function MicButton({
  state, theme, reduced, onPress,
}: { state: MicState; theme: Theme; reduced: boolean; onPress: () => void }) {
  const s = styles(theme)
  const live = state === 'live'
  const denied = state === 'denied'
  // The recognizer gave up three times in thirty seconds. Amber, not red: the ear
  // is not blocked, it is waiting for a tap (Pass 2).
  const restarting = state === 'restarting'
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
    outputRange: [denied ? theme.canvas : restarting ? theme.accent : theme.surfaceSecondary, theme.micLive],
  })
  const ink = live || restarting ? theme.canvas : denied ? theme.danger : theme.textSecondary

  return (
    <Pressable
      role="button"
      accessibilityLabel={MIC_LABEL[state]}
      onPress={onPress}
      style={s.control}
      testID="composer-mic"
    >
      <Animated.View style={[s.micCircle, { backgroundColor: background }, denied && s.micDenied]}>
        <Svg width={20} height={20} viewBox="0 0 24 24">
          <Path d={GLYPHS.mic} fill={ink} fillRule="evenodd" />
          {denied && <Path d={MIC_SLASH} fill={theme.danger} />}
        </Svg>
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
    fill: { backgroundColor: theme.surface }, // opaque: the list bled through at 0.96
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
  })
}
