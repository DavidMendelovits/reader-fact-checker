// Web build of kokoro.ts. Metro picks `.web.ts` over `.ts` on web, and the
// sherpa-onnx TurboModule throws the moment it is imported outside a native
// binary. In a browser the on-device voice simply isn't available; the system
// voice (expo-speech on the Web Speech API) carries the app.
import type { VoiceEngine } from './ports'

export async function isKokoroInstalled(): Promise<boolean> {
  return false
}

export async function installKokoro(): Promise<void> {
  throw new Error('The on-device voice needs the native app; this is the web build.')
}

export async function kokoroSizeMb(): Promise<number | null> {
  return null
}

export class KokoroVoice implements VoiceEngine {
  ready(): Promise<never> {
    return Promise.reject(new Error('The on-device voice needs the native app.'))
  }
  speak(): Promise<'done' | 'stopped'> {
    return Promise.resolve('done')
  }
  stop(): void {}
}
