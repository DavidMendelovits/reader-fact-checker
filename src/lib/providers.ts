// Composition root for the browser: which ear and which voice the reader runs
// on. Everything else imports these singletons and never touches a vendor or a
// browser speech API directly, so swapping either is a change to this file.
//
//   ear    Deepgram Flux streamed from the page's own echo-cancelled capture
//          when the server hands out grants (/api/listen), else Chrome's
//          SpeechRecognition on the same capture.
//   voice  the server's /api/tts, so the vendor is chosen server-side; an
//          in-browser synthesizer would be another AudioSource.
import type { Transcriber } from './ports'
import { VoiceListener } from './voice'
import { FluxListener } from './flux'
import { FirstAvailable } from './firstAvailable'
import { TtsPlayer, serverSpeech } from './tts'

export const voice: Transcriber = new FirstAvailable(new FluxListener(), new VoiceListener())
export const tts = new TtsPlayer(serverSpeech)
