// The two pieces of config: the user's Readwise token (theirs, entered once) and
// the base URL of the deployed web app, whose /api routes hold the model keys —
// nothing secret ever ships in this bundle.
import AsyncStorage from '@react-native-async-storage/async-storage'
import { Platform } from 'react-native'
// Namespace import, not named: theme.check.ts stubs this module in plain node,
// and a named import of a stub with no such export is a link-time error.
import * as SecureStore from 'expo-secure-store'

export const DEFAULT_API_BASE = process.env.EXPO_PUBLIC_API_BASE ?? 'https://reader-fact-checker.vercel.app'

const TOKEN_KEY = 'readwise-token'
const API_BASE_KEY = 'api-base'
const VOICE_KEY = 'voice'
const THEME_KEY = 'theme'
const HELLO_KEY = 'last-hello-day'

/**
 * The token is the one secret on the device, so it lives in the keychain
 * (expo-secure-store). The web build has no keychain and keeps AsyncStorage.
 */
const secureTokens = Platform.OS !== 'web'

/** The local calendar day, as "Sat Sep 20 2026". */
const today = () => new Date().toDateString()
let lastHelloDay: string | null = null

/**
 * True once a day, the first time it is asked. The agent's hello is spoken only
 * on the first launch of a calendar day (3.1A); every other launch is quiet.
 */
export function shouldSayHello(): boolean {
  const day = today()
  if (lastHelloDay === day) return false
  lastHelloDay = day
  void AsyncStorage.setItem(HELLO_KEY, day)
  return true
}

/** Which voice narrates: the OS voice, or Kokoro running on the device (see kokoro.ts). */
export type VoicePreference = 'system' | 'kokoro'

/** Follow the OS, or pin the light (Paper) or dark (Ink) theme. See theme.ts. */
export type ThemePreference = 'system' | 'paper' | 'ink'

export let apiBase = DEFAULT_API_BASE

export async function loadSettings(): Promise<{ token: string | null; voice: VoicePreference; theme: ThemePreference }> {
  const [token, base, voice, theme, hello] = await Promise.all([
    loadToken(),
    AsyncStorage.getItem(API_BASE_KEY),
    AsyncStorage.getItem(VOICE_KEY),
    AsyncStorage.getItem(THEME_KEY),
    AsyncStorage.getItem(HELLO_KEY),
  ])
  if (base) apiBase = base
  lastHelloDay = hello
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

/**
 * The token, from the keychain — moving it out of AsyncStorage the first time,
 * so an install that predates the keychain is migrated rather than signed out.
 */
async function loadToken(): Promise<string | null> {
  if (!secureTokens) return AsyncStorage.getItem(TOKEN_KEY)
  try {
    const kept = await SecureStore.getItemAsync(TOKEN_KEY)
    if (kept) return kept
  } catch {
    // The keychain can be unavailable (a locked device, a dev client without the
    // entitlement). Signing the reader out over it would be the worst answer:
    // fall back to whatever AsyncStorage still has, for this session.
    return AsyncStorage.getItem(TOKEN_KEY)
  }
  const old = await AsyncStorage.getItem(TOKEN_KEY)
  if (!old) return null
  try {
    await SecureStore.setItemAsync(TOKEN_KEY, old)
    await AsyncStorage.removeItem(TOKEN_KEY)
  } catch {
    // The move failed; the old copy stays exactly where it is, so the next launch
    // signs in and tries the migration again.
  }
  return old
}

export async function saveToken(token: string) {
  const value = token.trim()
  if (secureTokens) await SecureStore.setItemAsync(TOKEN_KEY, value)
  else await AsyncStorage.setItem(TOKEN_KEY, value)
}

/** Sign out: forget the token. The next launch shows the sign-in screen. */
export async function clearToken() {
  if (secureTokens) await SecureStore.deleteItemAsync(TOKEN_KEY)
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
    // The status rides on the error as a field: the shared loop's isOffline() reads
    // it there rather than off the message text (shared/voice/agent.ts).
    throw Object.assign(new Error(`${path} failed (${res.status}): ${detail.slice(0, 300)}`), {
      status: res.status,
    })
  }
  return res.json() as Promise<T>
}
