// Continuous speech input on expo-speech-recognition, mirroring the web
// VoiceListener (src/lib/voice.ts): no wake word, mic live during narration,
// the shared isEcho() throwing away the recognizer's transcription of the
// narration itself.
// iOS voice processing (AEC) is the native upgrade the web version could only
// wish for — the speakerphone story mostly just works here.
import {
  ExpoSpeechRecognitionModule,
  type ExpoSpeechRecognitionErrorEvent,
  type ExpoSpeechRecognitionResultEvent,
} from 'expo-speech-recognition'
import { setMicLevel } from './levels'
import type { Transcriber } from './ports'
// one echo filter for both listeners; its checks live next to it
import { isEcho } from '../../shared/voice/echo'

const words = (s: string) => s.toLowerCase().match(/[a-z0-9']+/g) ?? []
const countWords = (s: string) => words(s).length

const MIN_INTERIM_WORDS = 3

export class VoiceListener implements Transcriber {
  private running = false
  private talking = false
  private subs: { remove(): void }[] = []

  onUtterance: (text: string) => void = () => {}
  onInterim: (text: string) => void = () => {}
  onSpeechStart: () => void = () => {}
  onError: (msg: string) => void = () => {}
  getRecentSpokenText: () => string = () => ''

  async start() {
    if (this.running) return
    const perm = await ExpoSpeechRecognitionModule.requestPermissionsAsync()
    if (!perm.granted) {
      this.onError('Microphone access denied')
      return
    }
    this.running = true
    if (this.subs.length === 0) this.listen()
    this.spawn()
  }

  stop() {
    this.running = false
    ExpoSpeechRecognitionModule.stop()
  }

  private listen() {
    this.subs.push(
      ExpoSpeechRecognitionModule.addListener('result', (event: ExpoSpeechRecognitionResultEvent) => {
        const text = (event.results[0]?.transcript ?? '').trim()
        if (!text) return
        if (event.isFinal) {
          this.talking = false
          if (isEcho(text, this.getRecentSpokenText())) return
          this.onUtterance(text)
        } else if (!isEcho(text, this.getRecentSpokenText())) {
          this.onInterim(text)
          if (!this.talking && countWords(text) >= MIN_INTERIM_WORDS) {
            this.talking = true
            this.onSpeechStart()
          }
        }
      }),
      ExpoSpeechRecognitionModule.addListener('error', (event: ExpoSpeechRecognitionErrorEvent) => {
        if (event.error === 'not-allowed') {
          this.running = false
          this.onError('Microphone access denied')
        }
        // 'no-speech'/'aborted' are routine; the end handler respawns
      }),
      ExpoSpeechRecognitionModule.addListener('volumechange', (event: { value: number }) => setMicLevel(event.value)),
      ExpoSpeechRecognitionModule.addListener('end', () => {
        // the OS tears recognition down periodically; restart while enabled
        if (this.running) setTimeout(() => this.running && this.spawn(), 250)
      }),
    )
  }

  private spawn() {
    ExpoSpeechRecognitionModule.start({
      lang: 'en-US',
      interimResults: true,
      continuous: true,
      // the level behind the voice glow; a report every 80ms is plenty for a glow
      volumeChangeEventOptions: { enabled: true, intervalMillis: 80 },
      // Echo-cancel the mic against our own TTS so talking over the narration works
      // on the speaker, not just with headphones.
      iosVoiceProcessingEnabled: true,
      iosCategory: {
        category: 'playAndRecord',
        categoryOptions: ['defaultToSpeaker', 'allowBluetooth'],
        mode: 'voiceChat',
      },
    })
  }
}

