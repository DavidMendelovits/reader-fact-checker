// Continuous speech input built on webkitSpeechRecognition (Chrome).
//
// The agent conversation has no wake word: whatever you say is a turn. That means
// the mic stays live *while the document is being read* so you can talk over it —
// which is also how the recognizer ends up transcribing the narration itself.
// isEcho() throws those away.

type UtteranceHandler = (text: string) => void

const SpeechRecognitionCtor =
  (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition

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

/**
 * True when `heard` looks like the recognizer picking up `spoken` out of the
 * speakers rather than the user talking.
 *
 * ponytail: word-overlap heuristic. Reliable with headphones, mostly right on
 * speakers (Chrome applies its own AEC before we see a transcript). If it misfires
 * during a demo, the upgrade is a real AEC path — own the mic via getUserMedia with
 * echoCancellation and feed recognition from that stream.
 */
export function isEcho(heard: string, spoken: string): boolean {
  if (!spoken) return false
  const hw = words(heard)
  if (hw.length === 0) return true
  const sw = new Set(words(spoken))
  const overlap = hw.filter((w) => sw.has(w)).length / hw.length
  // short utterances share common words by chance, so demand near-total overlap
  return hw.length < 5 ? overlap === 1 : overlap > 0.6
}

export class VoiceListener {
  private rec: any = null
  private running = false
  // Two independent mutes: the echo guard flips constantly while the agent speaks,
  // so it must not be able to clear a mute the user set deliberately.
  private echoMuted = false
  private userMuted = false
  private talking = false // mid-utterance: interim words seen, final not yet in

  /** Fires on each finalized utterance that survived the echo filter. */
  onUtterance: UtteranceHandler = () => {}
  /**
   * Fires as soon as the user is *audibly* talking, well before the transcript
   * finalizes. Narration has to duck here — waiting for the final result means a
   * second or two of the book reading over you.
   */
  onSpeechStart: () => void = () => {}
  onError: (msg: string) => void = () => {}
  /** Text currently playing through the speakers, for echo rejection. */
  getSpokenText: () => string = () => ''

  start() {
    if (!speechSupported || this.running) return
    this.running = true
    this.spawn()
  }

  stop() {
    this.running = false
    this.rec?.stop()
    this.rec = null
  }

  /** Echo guard — driven by TTS while the agent's own voice is playing. */
  setMuted(muted: boolean) {
    this.echoMuted = muted
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

    rec.onresult = (event: any) => {
      if (this.echoMuted || this.userMuted) return
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
      if (
        !this.talking &&
        countWords(partial) >= MIN_INTERIM_WORDS &&
        confident(interimConf) &&
        !isEcho(partial, this.getSpokenText())
      ) {
        this.talking = true
        this.onSpeechStart()
      }

      const heard = finalText.trim()
      if (!heard) return
      this.talking = false
      // A single low-confidence word is almost always room noise the recognizer
      // guessed at. Finals with real confidence always pass, so "pause" survives.
      if (countWords(heard) <= 1 && !confident(finalConf)) return
      if (isEcho(heard, this.getSpokenText())) return
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
      // Chrome stops recognition periodically; restart while enabled
      if (this.running) setTimeout(() => this.running && this.spawn(), 250)
    }

    try {
      rec.start()
    } catch {
      /* already started */
    }
  }
}

export const voice = new VoiceListener()
