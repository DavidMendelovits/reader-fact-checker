// Which voice the player uses, and the one place that switches it. The system
// voice is the default and always works; Kokoro has to be downloaded once and is
// then loaded into memory at startup so the first paragraph doesn't wait on it.
import { KokoroVoice, installKokoro, isKokoroInstalled } from './kokoro'
import { saveVoice, type VoicePreference } from './settings'
import { SystemVoice, tts } from './tts'
import type { Progress } from 'react-native-sherpa-onnx/download'

let kokoro: KokoroVoice | null = null
let active: VoicePreference = 'system'

export const activeVoice = () => active

/**
 * Apply a preference. Falls back to the system voice — and reports it — when the
 * on-device model isn't installed, so a stale preference never silences the app.
 */
export async function useVoice(pref: VoicePreference): Promise<VoicePreference> {
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
