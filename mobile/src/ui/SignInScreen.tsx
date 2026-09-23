// One field, one button. What changed: the token is hidden while you type it,
// there is a Paste button because nobody types a 50-character token, the page
// that issues it is a link, and a bad token says so under the field rather than
// in a toast that covers the button (Pass 2, 3.1A).
import { useState } from 'react'
import {
  ActivityIndicator, Clipboard, Linking, Pressable, ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native'
import { KeyboardAvoidingView } from 'react-native-keyboard-controller'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { COPY } from '../../../shared/voice/line'
import { startLibrary } from '../session'
import { saveToken } from '../settings'
import { radius, size, space, useTheme, weight, type as type_, type Theme } from '../theme'
import { errorText } from './kit'
import { COLUMN_MAX_WIDTH } from './layout'

const TOKEN_PAGE = 'https://readwise.io/access_token'

export function SignInScreen({ onSaved }: { onSaved: (t: string) => void }) {
  const theme = useTheme()
  const s = styles(theme)
  const insets = useSafeAreaInsets()
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async () => {
    const token = value.trim()
    if (!token || busy) return
    setBusy(true)
    setError(null)
    try {
      await saveToken(token)
      await startLibrary(token)
      // The mic is deliberately not turned on here: the OS prompts belong to the
      // first tap on it, not to signing in (3.1A).
      onSaved(token)
    } catch (e) {
      setError(errorText(e))
      setBusy(false)
    }
  }

  // Clipboard is deprecated in react-native core but still shipped in 0.86, and
  // expo-clipboard is not installed. ponytail: swap it the day it is removed.
  const paste = () => {
    void Promise.resolve(Clipboard.getString())
      .then((text) => text && setValue(text.trim()))
      .catch(() => {})
  }

  return (
    <KeyboardAvoidingView behavior="padding" style={s.fill}>
      <ScrollView
        contentContainerStyle={[s.body, { paddingTop: insets.top + space.xxl, paddingBottom: insets.bottom + space.xxl }]}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={s.h1}>{COPY.productName}</Text>
        <Text style={s.prose}>Paste your Readwise access token. It stays on this device.</Text>
        <Pressable role="button" accessibilityLabel="Open readwise.io/access_token" style={s.linkRow} onPress={() => void Linking.openURL(TOKEN_PAGE)}>
          <Text style={s.link}>readwise.io/access_token</Text>
        </Pressable>
        <View style={s.field}>
          <TextInput
            style={s.input}
            value={value}
            onChangeText={(t) => {
              setValue(t)
              setError(null)
            }}
            placeholder="Access token"
            placeholderTextColor={theme.textTertiary}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            editable={!busy}
            accessibilityLabel="Access token"
          />
          <Pressable role="button" accessibilityLabel="Paste" style={s.paste} onPress={paste} disabled={busy}>
            <Text style={s.link}>Paste</Text>
          </Pressable>
        </View>
        {error && <Text style={s.error}>{error}</Text>}
        <Pressable
          role="button"
          accessibilityLabel="Open my library"
          style={[s.button, (!value.trim() || busy) && s.dim]}
          disabled={!value.trim() || busy}
          onPress={() => void save()}
        >
          {busy ? <ActivityIndicator color={theme.canvas} /> : <Text style={s.buttonText}>Open my library</Text>}
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
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
    fill: { flex: 1 },
    body: {
      flexGrow: 1, justifyContent: 'center', gap: space.md,
      paddingHorizontal: space.xxl,
      width: '100%', maxWidth: COLUMN_MAX_WIDTH, alignSelf: 'center',
    },
    h1: { ...type_.title, color: theme.textPrimary },
    prose: { ...type_.prose, color: theme.textSecondary },
    link: { ...type_.ui, color: theme.accent, fontWeight: weight.semibold },
    linkRow: { minHeight: size.target, justifyContent: 'center' },
    field: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
    input: {
      flex: 1, minHeight: size.target, paddingHorizontal: space.md,
      borderWidth: 1, borderColor: theme.hairline, borderRadius: radius.input,
      ...type_.input, backgroundColor: theme.surface, color: theme.textPrimary,
    },
    paste: { minHeight: size.target, minWidth: size.target, alignItems: 'center', justifyContent: 'center', paddingHorizontal: space.sm },
    error: { ...type_.meta, color: theme.danger },
    button: {
      minHeight: size.target, alignItems: 'center', justifyContent: 'center',
      backgroundColor: theme.textPrimary, borderRadius: radius.input,
    },
    buttonText: { ...type_.ui, color: theme.canvas, fontWeight: weight.semibold },
    dim: { opacity: 0.4 },
  })
}
