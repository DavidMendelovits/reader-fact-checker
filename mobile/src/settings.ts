// The two pieces of config: the user's Readwise token (theirs, entered once) and
// the base URL of the deployed web app, whose /api routes hold the model keys —
// nothing secret ever ships in this bundle.
import AsyncStorage from '@react-native-async-storage/async-storage'

export const DEFAULT_API_BASE = process.env.EXPO_PUBLIC_API_BASE ?? 'https://reader-fact-checker.vercel.app'

const TOKEN_KEY = 'readwise-token'
const API_BASE_KEY = 'api-base'
const VOICE_KEY = 'voice'
const THEME_KEY = 'theme'

/** Which voice narrates: the OS voice, or Kokoro running on the device (see kokoro.ts). */
export type VoicePreference = 'system' | 'kokoro'

/** Follow the OS, or pin the light (Paper) or dark (Ink) theme. See theme.ts. */
export type ThemePreference = 'system' | 'paper' | 'ink'

export let apiBase = DEFAULT_API_BASE

export async function loadSettings(): Promise<{ token: string | null; voice: VoicePreference; theme: ThemePreference }> {
  const [token, base, voice, theme] = await Promise.all([
    AsyncStorage.getItem(TOKEN_KEY),
    AsyncStorage.getItem(API_BASE_KEY),
    AsyncStorage.getItem(VOICE_KEY),
    AsyncStorage.getItem(THEME_KEY),
  ])
  if (base) apiBase = base
  return {
    token,
    voice: voice === 'kokoro' ? 'kokoro' : 'system',
    theme: theme === 'paper' || theme === 'ink' ? theme : 'system',
  }
}

export async function saveVoice(voice: VoicePreference) {
  await AsyncStorage.setItem(VOICE_KEY, voice)
}

export async function saveTheme(theme: ThemePreference) {
  await AsyncStorage.setItem(THEME_KEY, theme)
}

export async function saveToken(token: string) {
  await AsyncStorage.setItem(TOKEN_KEY, token.trim())
}

/** Sign out: forget the token. The next launch shows the sign-in screen. */
export async function clearToken() {
  await AsyncStorage.removeItem(TOKEN_KEY)
}

export async function saveApiBase(base: string) {
  apiBase = base.trim().replace(/\/$/, '') || DEFAULT_API_BASE
  await AsyncStorage.setItem(API_BASE_KEY, apiBase)
}

export async function apiJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${apiBase}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`${path} failed (${res.status}): ${detail.slice(0, 300)}`)
  }
  return res.json() as Promise<T>
}
