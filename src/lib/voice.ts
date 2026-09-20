// Continuous speech input built on webkitSpeechRecognition (Chrome).
//
// The agent conversation has no wake word: whatever you say is a turn. That means
// the mic stays live *while the document is being read* so you can talk over it —
// which is also how the recognizer ends up transcribing the narration itself.
// isEcho() (shared/voice/echo.ts) throws those away.

// extension-explicit so this file can run under node --experimental-strip-types
import { getMicStream } from './audio-levels.ts'
import type { Transcriber } from './ports.ts'
// the echo filter is shared with the phone listener; checks live next to it
import { isEcho } from '../../shared/voice/echo.ts'

type UtteranceHandler = (text: string) => void

const SpeechRecognitionCtor =
  typeof window === 'undefined'
    ? undefined
    : ((window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition)

export const speechSupported = Boolean(SpeechRecognitionCtor)

const words = (s: string) => s.toLowerCase().match(/[a-z0-9']+/g) ?? []
const countWords = (s: string) => words(s).length

/**
 * ponytail: false-positive guard for the barge-in path. Chrome reports confidence
 * as 0 on most interim results and sometimes on finals too, so a zero can only mean
 * "no opinion" — treat it as a pass and let the word count carry the decision.
 * The real fix is owning the mic: getUserMedia with echoCancellation/noiseSuppression
 * plus an RMS gate, and feeding recognition from that stream.
 */
const MIN_INTERIM_WORDS = 3
const MIN_CONFIDENCE = 0.5
const confident = (c: number) => c <= 0 || c >= MIN_CONFIDENCE

export class VoiceListener implements Transcriber {
  readonly supported = speechSupported
  private rec: any = null
  private running = false
  private track: MediaStreamTrack | null = null
  private userMuted = false
  private talking = false // mid-utterance: interim words seen, final not yet in
  private spawnedAt = 0
  private rapidDeaths = 0 // consecutive spawns that died almost immediately

  /** Fires on each finalized utterance that survived the echo filter. */
  onUtterance: UtteranceHandler = () => {}
  /**
   * Fires on every in-progress transcript that survived the echo filter, several
   * times per utterance as it grows. Only safe to act on when the partial can mean
   * exactly one thing — it may still change before it finalizes.
   */
  onInterim: UtteranceHandler = () => {}
  /**
   * Fires as soon as the user is *audibly* talking, well before the transcript
   * finalizes. Narration has to duck here — waiting for the final result means a
   * second or two of the book reading over you.
   */
  onSpeechStart: () => void = () => {}
  onError: (msg: string) => void = () => {}
  /** Text currently playing through the speakers, for echo rejection. */
  getSpokenText: () => string = () => ''
  /**
   * That plus whatever played in the last few seconds. Recognition finalizes late,
   * so by the time an echo arrives the audio it came from is already over.
   */
  getRecentSpokenText: () => string = () => ''

  /**
   * Recognition runs on our own echo-cancelled capture rather than the implicit one
   * Chrome opens for itself. That is the whole speakerphone story: without the
   * cancelled stream the mic hears the narration as clearly as it hears the user,
   * the transcript is a mixture of both, and isEcho() below throws away the result.
   *
   * SpeechRecognition.start() taking a MediaStreamTrack is recent; if this Chrome
   * doesn't honour it we fall back to the default capture, which is exactly the old
   * behaviour — headphones fine, speakers poor.
   */
  async start() {
    if (!speechSupported || this.running) return
    this.running = true
    this.rapidDeaths = 0 // a fresh start (mic re-enabled) retries from a clean slate
    try {
      this.track = (await getMicStream()).getAudioTracks()[0] ?? null
    } catch (e) {
      this.track = null
      console.warn('mic capture unavailable; recognition falls back to the default device', e)
    }
    if (this.running) this.spawn() // stop() may have landed while we were awaiting
  }

  stop() {
    this.running = false
    this.track = null
    this.rec?.stop()
    this.rec = null
  }

  /**
   * User-controlled mute. Recognition keeps running so unmuting is instant and
   * doesn't re-prompt for permission; we just drop what we hear.
   */
  setUserMuted(muted: boolean) {
    this.userMuted = muted
  }

  private spawn() {
    const rec = new SpeechRecognitionCtor()
    this.rec = rec
    rec.continuous = true
    rec.interimResults = true
    rec.lang = 'en-US'

    // The agent's own voice used to hard-mute this handler. That silently threw away
    // anything Chrome finalized in the window — and Chrome delivers a final a beat
    // *after* the audio it heard, so a sentence started while the agent was talking
    // vanished outright, and one spanning the boundary arrived with its head missing.
    // Nothing recovers a dropped final: event.resultIndex has already moved past it.
    // isEcho() against recentlySpoken is the guard now, which is what it was built
    // for — the agent's reply is verbatim in there, so a true echo matches on the
    // nose while a barge-in over it gets through.
    rec.onresult = (event: any) => {
      if (this.userMuted) return
      let finalText = ''
      let interim = ''
      let interimConf = 0
      let finalConf = 0
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const r = event.results[i]
        if (r.isFinal) {
          finalText += r[0].transcript
          finalConf = Math.max(finalConf, r[0].confidence ?? 0)
        } else {
          interim += r[0].transcript
          interimConf = Math.max(interimConf, r[0].confidence ?? 0)
        }
      }

      // Duck narration on the first credible interim words of an utterance. Credible
      // is deliberately strict: ducking on a cough or a passing conversation stops
      // the book for no reason, and the cost of a miss is only that the first word
      // of a real command plays over.
      const partial = interim.trim()
      if (partial && confident(interimConf) && !isEcho(partial, this.getRecentSpokenText())) {
        // Every credible partial goes out. Transport commands are one or two words,
        // so they never reach the ducking threshold below, and Chrome only finalizes
        // an utterance after a beat of trailing silence — waiting for that put a
        // second between "stop" and anything happening. The consumer acts only on
        // partials that can't mean anything else.
        this.onInterim(partial)
        if (!this.talking && countWords(partial) >= MIN_INTERIM_WORDS) {
          this.talking = true
          this.onSpeechStart()
        }
      }

      const heard = finalText.trim()
      if (!heard) return
      this.talking = false
      // A single low-confidence word is almost always room noise the recognizer
      // guessed at. Finals with real confidence always pass, so "pause" survives.
      if (countWords(heard) <= 1 && !confident(finalConf)) return
      if (isEcho(heard, this.getRecentSpokenText())) return
      this.onUtterance(heard)
    }

    rec.onerror = (e: any) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        this.running = false
        this.onError('Microphone access denied')
      }
      // 'no-speech'/'aborted' are routine; onend restarts
    }

    rec.onend = () => {
      if (!this.running) return
      // Chrome stops recognition periodically; restart while enabled. A healthy
      // session runs for a while before ending — one that dies within a second of
      // starting (recognition service unreachable, mic gone) would respawn in a
      // 250ms hot loop forever, invisibly. Back off on those, and after a sustained
      // run of them stop and say so: the mic button flipping off is the honest
      // signal, and tapping it retries.
      const rapid = Date.now() - this.spawnedAt < 1000
      this.rapidDeaths = rapid ? this.rapidDeaths + 1 : 0
      if (this.rapidDeaths >= 8) {
        this.running = false
        this.onError('Voice recognition keeps failing — tap the mic to try again')
        return
      }
      const delay = rapid ? Math.min(250 * 2 ** this.rapidDeaths, 8000) : 250
      setTimeout(() => this.running && this.spawn(), delay)
    }

    // Chrome tears recognition down every so often and onend respawns it, so the
    // track has to survive across spawns — but not past the stream being released.
    this.spawnedAt = Date.now()
    const live = this.track?.readyState === 'live' ? this.track : null
    try {
      if (live) rec.start(live)
      else rec.start()
    } catch (e: any) {
      // InvalidStateError is the harmless double-start. Anything else with a track
      // means this Chrome won't take one: drop it and run on the default capture.
      if (live && e?.name !== 'InvalidStateError') {
        console.warn('SpeechRecognition rejected our stream; using the default capture', e)
        this.track = null
        try {
          rec.start()
        } catch {
          /* already started */
        }
      }
    }
  }
}

