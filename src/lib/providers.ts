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

const query = new URLSearchParams(location.search)
let choice = query.get('voice')
try {
  if (choice === 'paradee' || choice === 'server') localStorage.setItem('rfc-voice', choice)
  else choice = localStorage.getItem('rfc-voice')
} catch {
  /* storage blocked: the URL still decides for this load */
}
/** Paradee when it's the voice in use, so the app can preload it and show it loading. */
export const pageVoice = choice === 'paradee' ? paradeeSpeech : null
export const tts = new TtsPlayer(pageVoice ?? serverSpeech)

// ?sentenceGap=<ms>&paragraphGap=<ms>: the pauses Paradee's player leaves between
// sentences and after a paragraph, remembered (clamped) like the voice.
const stored = (key: string) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
const ms = (v: string | null) => parseFloat(v ?? '') // NaN, which setGaps ignores, when absent
tts.setGaps({ sentence: ms(stored('rfc-sentence-gap')), paragraph: ms(stored('rfc-paragraph-gap')) })
tts.setGaps({ sentence: ms(query.get('sentenceGap')), paragraph: ms(query.get('paragraphGap')) })
try {
  if (query.has('sentenceGap')) localStorage.setItem('rfc-sentence-gap', String(tts.sentenceGap))
  if (query.has('paragraphGap')) localStorage.setItem('rfc-paragraph-gap', String(tts.paragraphGap))
} catch {
  /* storage blocked: the URL still decides for this load */
}
