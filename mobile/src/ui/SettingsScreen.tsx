// Four settings and a way out. The voice download shows a real bar rather than
// a label that counts (Pass 2), and the API field says what is wrong while you
// are still in it.
import { useEffect, useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { KeyboardAvoidingView } from 'react-native-keyboard-controller'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { resetConversation, setMicEnabled } from '../agent'
import { kokoroSizeMb } from '../kokoro'
import { activeVoice, enableKokoro, useVoice } from '../providers'
import { refreshLibrary, stopLibrary } from '../session'
import { apiBase, clearToken, saveApiBase, type ThemePreference } from '../settings'
import { useStore } from '../store'
import { radius, space, type as type_, setThemePreference, themePreference, useTheme, type Theme } from '../theme'
import { Composer } from './Composer'
import { errorText } from './kit'
import { COLUMN_MAX_WIDTH } from './layout'
import { useBottomInset } from './useBottomInset'
import app from '../../app.json'

const THEMES: { value: ThemePreference; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'paper', label: 'Paper' },
  { value: 'ink', label: 'Ink' },
]

/** Good enough to catch "readwise.io" and a typo'd scheme; the fetch does the rest. */
const looksLikeUrl = (value: string) => /^https?:\/\/[^\s/]+/i.test(value.trim())

export function SettingsScreen({ onSignOut }: { onSignOut: () => void }) {
  const theme = useTheme()
  const s = styles(theme)
  const insets = useSafeAreaInsets()
  const bottomInset = useBottomInset()
  const syncing = useStore((st) => st.syncing)
  const lastSync = useStore((st) => st.lastSync)
  const [base, setBase] = useState(apiBase)
  const [signingOut, setSigningOut] = useState(false)
  const baseValid = looksLikeUrl(base) || base.trim() === ''

  const saveBase = async () => {
    if (!baseValid) return
    await saveApiBase(base)
    setBase(apiBase) // the normalized value (trailing slash dropped, default restored if blank)
  }

  const signOut = async () => {
    if (signingOut) return
    setSigningOut(true)
    try {
      resetConversation()
      setMicEnabled(false)
      stopLibrary()
      await clearToken()
      const st = useStore.getState()
      st.setLibraryQuery('')
      st.setMicState('notAsked') // the next sign-in starts from the hint again
      st.setScreen('library') // where the next sign-in lands
      onSignOut()
    } catch (e) {
      useStore.getState().setNotice(errorText(e))
      setSigningOut(false)
    }
  }

  return (
    <View style={s.screen}>
      <View style={[s.header, { paddingTop: insets.top + space.md }]}>
        <Pressable role="button" accessibilityLabel="Back to library" style={s.headerButton} onPress={() => useStore.getState().setScreen('library')}>
          <Text style={s.link}>‹ Library</Text>
        </Pressable>
        <Text style={s.title} numberOfLines={1}>Settings</Text>
        <View style={s.headerButton} />
      </View>
      <KeyboardAvoidingView behavior="padding" style={s.fill}>
        <ScrollView
          style={s.fill}
          contentContainerStyle={[s.body, { paddingBottom: bottomInset }]}
          keyboardShouldPersistTaps="handled"
        >
          <View style={s.block}>
            <Text style={s.label}>Theme</Text>
            <Segmented
              theme={theme}
              options={THEMES.map((t) => t.label)}
              selected={THEMES.findIndex((t) => t.value === themePreference())}
              onSelect={(i) => setThemePreference(THEMES[i].value)}
            />
          </View>

          <VoicePicker theme={theme} />

          <View style={s.block}>
            <Text style={s.label}>API base URL</Text>
            <TextInput
              style={[s.input, !baseValid && s.inputBad]}
              value={base}
              onChangeText={setBase}
              onBlur={() => void saveBase()}
              placeholder={apiBase}
              placeholderTextColor={theme.textTertiary}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              accessibilityLabel="API base URL"
            />
            {baseValid ? (
              <Text style={s.hint}>The deployed web app whose /api routes the phone talks to. Saved when you leave the field.</Text>
            ) : (
              <Text style={s.error}>Not a URL</Text>
            )}
          </View>

          <View style={s.row}>
            <View style={s.fill}>
              <Text style={s.label}>Library</Text>
              <Text style={s.hint}>
                {syncing ? 'syncing…' : lastSync ? `last synced ${new Date(lastSync).toLocaleString()}` : 'not synced yet'}
              </Text>
            </View>
            <Pressable role="button" accessibilityLabel="Resync library" style={s.headerButton} disabled={syncing} onPress={() => void refreshLibrary({ full: true })}>
              <Text style={[s.link, syncing && s.dim]}>Resync</Text>
            </Pressable>
          </View>

          <Pressable
            role="button"
            accessibilityLabel="Sign out"
            style={[s.signOut, signingOut && s.dim]}
            disabled={signingOut}
            onPress={() => void signOut()}
          >
            {signingOut ? <ActivityIndicator color={theme.canvas} /> : <Text style={s.signOutText}>Sign out</Text>}
          </Pressable>
          {/* the cheapest "did this build land" check: the version, on screen */}
          <Text style={s.version} accessibilityLabel={`readwithme version ${app.expo.version}`}>readwithme {app.expo.version}</Text>
        </ScrollView>
      </KeyboardAvoidingView>
      <Composer />
    </View>
  )
}

/** System voice or on-device Kokoro, with the download drawn rather than counted. */
function VoicePicker({ theme }: { theme: Theme }) {
  const s = styles(theme)
  const [voice, setVoice] = useState(activeVoice())
  const [progress, setProgress] = useState<{ phase: string; percent: number } | null>(null)
  const [failed, setFailed] = useState(false)
  const [sizeMb, setSizeMb] = useState<number | null>(null)

  useEffect(() => {
    void kokoroSizeMb().then(setSizeMb)
  }, [])

  const pick = async (index: number) => {
    if (progress) return
    if (index === 0) {
      setVoice(await useVoice('system'))
      return
    }
    setFailed(false)
    setProgress({ phase: 'preparing', percent: 0 })
    try {
      await enableKokoro((p) => setProgress({ phase: p.phase, percent: p.percent }))
      setVoice('kokoro')
    } catch {
      setFailed(true)
      setVoice(await useVoice('system'))
    } finally {
      setProgress(null)
    }
  }

  return (
    <View style={s.block}>
      <Text style={s.label}>Voice</Text>
      <Segmented
        theme={theme}
        options={['System', sizeMb !== null && voice !== 'kokoro' ? `On-device (${sizeMb}MB)` : 'On-device']}
        selected={voice === 'kokoro' ? 1 : 0}
        onSelect={(i) => void pick(i)}
        disabled={!!progress}
      />
      {progress && (
        <>
          <View style={s.bar}>
            <View style={[s.barFill, { width: `${Math.max(2, Math.round(progress.percent))}%` }]} />
          </View>
          <Text style={s.hint}>{progress.phase} {Math.round(progress.percent)}%</Text>
        </>
      )}
      {failed && <Text style={s.error}>On-device voice unavailable. Tap it again to retry.</Text>}
    </View>
  )
}

function Segmented({
  theme, options, selected, onSelect, disabled,
}: { theme: Theme; options: string[]; selected: number; onSelect: (i: number) => void; disabled?: boolean }) {
  const s = styles(theme)
  return (
    <View style={s.segmented}>
      {options.map((option, i) => (
        <Pressable
          key={option}
          role="button"
          accessibilityLabel={option}
          accessibilityState={{ selected: i === selected, disabled: !!disabled }}
          style={[s.segment, i === selected && s.segmentOn]}
          disabled={disabled}
          onPress={() => onSelect(i)}
        >
          <Text style={[s.segmentText, i === selected && s.segmentTextOn]} numberOfLines={1}>{option}</Text>
        </Pressable>
      ))}
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
    fill: { flex: 1 },
    header: {
      flexDirection: 'row', alignItems: 'center', gap: space.md,
      paddingHorizontal: space.lg, paddingBottom: space.md,
      borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.hairline,
    },
    headerButton: { minHeight: 44, minWidth: 64, justifyContent: 'center' },
    title: { ...type_.ui, fontWeight: '600', color: theme.textPrimary, flex: 1, textAlign: 'center' },
    link: { ...type_.ui, color: theme.accent, fontWeight: '600' },
    dim: { opacity: 0.4 },
    body: {
      padding: space.xl, gap: space.xxl,
      width: '100%', maxWidth: COLUMN_MAX_WIDTH, alignSelf: 'center',
    },
    block: { gap: space.sm },
    row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.md },
    label: { ...type_.ui, fontWeight: '600', color: theme.textPrimary },
    hint: { ...type_.meta, color: theme.textTertiary },
    version: { ...type_.meta, color: theme.textTertiary, textAlign: 'center', marginTop: space.xl },
    error: { ...type_.meta, color: theme.danger },
    input: {
      borderWidth: 1, borderColor: theme.hairline, borderRadius: radius.input,
      paddingHorizontal: space.md, minHeight: 44,
      fontSize: 16, backgroundColor: theme.surface, color: theme.textPrimary,
    },
    inputBad: { borderColor: theme.danger },
    segmented: {
      flexDirection: 'row', backgroundColor: theme.surfaceSecondary,
      borderRadius: radius.input, padding: space.xs / 2,
    },
    segment: { flex: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: radius.input },
    segmentOn: { backgroundColor: theme.surface },
    segmentText: { ...type_.meta, color: theme.textTertiary, fontWeight: '600' },
    segmentTextOn: { color: theme.textPrimary },
    bar: { height: 4, borderRadius: radius.pill, backgroundColor: theme.surfaceSecondary, overflow: 'hidden' },
    barFill: { height: 4, borderRadius: radius.pill, backgroundColor: theme.accent },
    signOut: {
      minHeight: 44, alignItems: 'center', justifyContent: 'center',
      backgroundColor: theme.danger, borderRadius: radius.input,
    },
    signOutText: { ...type_.ui, color: theme.canvas, fontWeight: '600' },
  })
}
