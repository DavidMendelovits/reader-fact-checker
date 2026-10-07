// Composition root for the browser: which ear and which voice the reader runs
// on. Everything else imports these singletons and never touches a vendor or a
// browser speech API directly, so swapping either is a change to this file.
//
//   ear    Chrome's SpeechRecognition on the page's own echo-cancelled capture.
//          A streaming STT vendor (Deepgram, AssemblyAI, ...) would be another
//          Transcriber fed from the same getMicStream().
//   voice  the server's /api/tts by default, so the vendor is chosen server-side.
//          ?voice=paradee switches to Paradee, synthesized in the page
//          (paradee.ts), and ?voice=server switches back; the choice is
//          remembered in localStorage so the A/B survives reloads.
import type { Transcriber } from './ports'
import { VoiceListener } from './voice'
import { TtsPlayer, serverSpeech } from './tts'
import { paradeeSpeech } from './paradee'

export const voice: Transcriber = new VoiceListener()

let choice = new URLSearchParams(location.search).get('voice')
try {
  if (choice === 'paradee' || choice === 'server') localStorage.setItem('rfc-voice', choice)
  else choice = localStorage.getItem('rfc-voice')
} catch {
  /* storage blocked: the URL still decides for this load */
}
export const tts = new TtsPlayer(choice === 'paradee' ? paradeeSpeech : serverSpeech)
