// The root, and only the root. The screens live in src/ui/; what is left here
// is the order of the layers — safe area, keyboard, paper, screen, toast,
// aurora — and the boot: settings, then the library from cache, then the voice.
//
// The mic is not turned on here. The OS asks for it on the first tap of the
// Composer's mic, not on the way in (3.1A).
import { StatusBar } from 'expo-status-bar'
import { useEffect, useState, type ReactNode } from 'react'
import { ActivityIndicator, StyleSheet, View } from 'react-native'
import { KeyboardProvider } from 'react-native-keyboard-controller'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { useVoice, voice } from './src/providers'
import { startLibrary } from './src/session'
import { loadSettings } from './src/settings'
import { useStore } from './src/store'
import { setThemePreference, useTheme } from './src/theme'
import { errorText } from './src/ui/kit'
import { LibraryScreen } from './src/ui/LibraryScreen'
import { ReaderScreen } from './src/ui/ReaderScreen'
import { SettingsScreen } from './src/ui/SettingsScreen'
import { SignInScreen } from './src/ui/SignInScreen'
import { Toast } from './src/ui/Toast'

/**
 * The aurora is Skia, and Skia is native. In production it is a hard dependency
 * and its absence is a boot failure, as it should be; in development a broken or
 * half-built dev client must not take the whole app down with it (X8).
 */
const Aurora: () => ReactNode = __DEV__ ? devAurora() : require('./src/Aurora').default
function devAurora(): () => ReactNode {
  try {
    return require('./src/Aurora').default as () => ReactNode
  } catch {
    return () => null
  }
}

/** The line says "Loading voice…" for at most this long, however slow the model is. */
const VOICE_LOADING_CAP_MS = 2000

export default function App() {
  return (
    <SafeAreaProvider>
      <KeyboardProvider>
        <Root />
      </KeyboardProvider>
    </SafeAreaProvider>
  )
}

function Root() {
  const theme = useTheme()
  const screen = useStore((s) => s.screen)
  const [token, setToken] = useState<string | null>(null)
  const [booted, setBooted] = useState(false)

  useEffect(() => {
    // "Microphone access denied" is the one error the toast does not take: the
    // Composer's mic shows it, and it is the only thing that can undo it (Pass 2).
    const reportError = voice.onError
    voice.onError = (message: string) => {
      if (/microphone access denied/i.test(message)) {
        useStore.setState({ micEnabled: false, micState: 'denied' })
        return
      }
      // Same reasoning for a recognizer that has died three times in thirty
      // seconds (voice.ts): the mic goes amber and the line says "tap to retry",
      // which is the only thing that helps. A toast on top would just be noise.
      if (/keeps failing/i.test(message)) {
        useStore.setState({ micEnabled: false, micState: 'restarting' })
        return
      }
      reportError(message)
    }

    void loadSettings().then(async ({ token, voice: preference, theme: themePreference }) => {
      setThemePreference(themePreference)
      if (token) {
        try {
          await startLibrary(token) // the cached list, instantly; the sync fills in behind it
        } catch (e) {
          useStore.getState().setNotice(`Couldn't open your library: ${errorText(e)}`)
        }
      }
      setToken(token)
      setBooted(true)
      // After the first paint: the voice model, which is heavy. Loading the
      // on-device one is the line's business for up to two seconds (Pass 2) and
      // nothing is pushed to the chat about it; Play works on the system voice
      // meanwhile, which providers.ts guarantees.
      setTimeout(() => {
        if (preference !== 'kokoro') {
          void useVoice(preference)
          return
        }
        const store = useStore.getState()
        store.setVoiceLoading(true)
        const giveUp = setTimeout(() => useStore.getState().setVoiceLoading(false), VOICE_LOADING_CAP_MS)
        void useVoice(preference).finally(() => {
          clearTimeout(giveUp)
          useStore.getState().setVoiceLoading(false)
        })
      }, 0)
    })
  }, [])

  const paper = [styles.root, { backgroundColor: theme.canvas }]
  if (!booted) {
    return (
      <View style={[paper, styles.centered]}>
        <ActivityIndicator color={theme.accent} />
      </View>
    )
  }

  return (
    <View style={paper}>
      <StatusBar style={theme.name === 'ink' ? 'light' : 'dark'} />
      {!token ? (
        <SignInScreen onSaved={setToken} />
      ) : screen === 'reader' ? (
        <ReaderScreen />
      ) : screen === 'settings' ? (
        <SettingsScreen onSignOut={() => setToken(null)} />
      ) : (
        <LibraryScreen />
      )}
      <Toast />
      {token && <Aurora />}
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  centered: { alignItems: 'center', justifyContent: 'center' },
})
