// Composition root for the native app: the ear, the player, and which voice
// engine the player runs on. The system voice is the default and always works;
// Kokoro has to be downloaded once and is then loaded into memory at startup so
// the first paragraph doesn't wait on it. Everything else imports the singletons
// from here and never names a vendor.
import { KokoroVoice, installKokoro, isKokoroInstalled } from './kokoro'
import { saveVoice, type VoicePreference } from './settings'
import { Player, SilentVoice, SystemVoice } from './tts'
import { VoiceListener } from './voice'
import type { Transcriber } from './ports'
import type { Progress } from 'react-native-sherpa-onnx/download'

export const voice: Transcriber = new VoiceListener()
export const tts = new Player()

let kokoro: KokoroVoice | null = null
let active: VoicePreference = 'system'

export const activeVoice = () => active

/**
 * Apply a preference. Falls back to the system voice — and reports it — when the
 * on-device model isn't installed, so a stale preference never silences the app.
 */
export async function useVoice(pref: VoicePreference): Promise<VoicePreference> {
  // EXPO_PUBLIC_SILENT_VOICE: no audio at all, for the browser smoke test
  if (process.env.EXPO_PUBLIC_SILENT_VOICE) {
    tts.setEngine(new SilentVoice())
    active = 'system'
    return 'system'
  }
  if (pref === 'kokoro') {
    if (!(await isKokoroInstalled())) pref = 'system'
    else {
      kokoro ??= new KokoroVoice()
      void kokoro.ready().catch((e) => console.warn('kokoro: warm-up failed', e))
      tts.setEngine(kokoro)
    }
  }
  if (pref === 'system') tts.setEngine(new SystemVoice())
  active = pref
  await saveVoice(pref)
  return pref
}

/** Download the model if needed, then switch to it. */
export async function enableKokoro(onProgress?: (p: Progress) => void): Promise<void> {
  if (!(await isKokoroInstalled())) await installKokoro(onProgress)
  await useVoice('kokoro')
}
