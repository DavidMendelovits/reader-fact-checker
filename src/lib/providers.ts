// Composition root for the browser: which ear and which voice the reader runs
// on. Everything else imports these singletons and never touches a vendor or a
// browser speech API directly, so swapping either is a change to this file.
//
//   ear    Chrome's SpeechRecognition on the page's own echo-cancelled capture.
//          A streaming STT vendor (Deepgram, AssemblyAI, ...) would be another
//          Transcriber fed from the same getMicStream().
//   voice  the server's /api/tts, so the vendor is chosen server-side; an
//          in-browser synthesizer would be another AudioSource.
import type { Transcriber } from './ports'
import { VoiceListener } from './voice'
import { TtsPlayer, serverSpeech } from './tts'

export const voice: Transcriber = new VoiceListener()
export const tts = new TtsPlayer(serverSpeech)
