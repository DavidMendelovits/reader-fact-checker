// Continuous speech input built on webkitSpeechRecognition (Chrome).
//
// The agent conversation has no wake word: whatever you say is a turn. That means
// the mic stays live *while the document is being read* so you can talk over it —
// which is also how the recognizer ends up transcribing the narration itself.
// isEcho()/stripEcho() (shared/voice/echo.ts) throw those away.
//
// Three policies are shared with the phone listener and checked next to
// themselves: BargeInGate decides when the user is audibly talking (from the mic
// level, ~160ms in, rather than from a transcript that arrives a second late),
// RestartPolicy decides who may respawn the recognizer, and echo.ts decides what
// was the book talking. What is left here is the browser.

// extension-explicit so this file can run under node --experimental-strip-types
import { getMicStream, readLevels } from './audio-levels.ts'
import type { Transcriber } from './ports.ts'
import { BargeInGate } from '../../shared/voice/bargeIn.ts'
import { isEcho, stripEcho } from '../../shared/voice/echo.ts'
import { RestartPolicy } from '../../shared/voice/restartPolicy.ts'

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

/** How often the mic level is read for the barge-in gate, matching the phone's. */
const LEVEL_INTERVAL_MS = 80
/**
 * Above this, readLevels('mic') is a voice rather than the room — the same floor
 * the aurora uses to decide the level it draws is the user's (plan 3.2A). The
 * phone's scale is different, so it keeps the gate's own default. Tuning either
 * takes a real speaker at full volume; a hold that turns out to be nothing costs
 * a 1.5s silence and resumes on its own.
 */
const SPEECH_FLOOR = 0.08
/** Respawn delay after a routine `end`. */
const RESTART_DELAY_MS = 250
/** A session that ends this soon after starting never really ran. */
const RAPID_DEATH_MS = 1000
const MAX_RAPID_DEATHS = 8
const MAX_BACKOFF_MS = 8000

export class VoiceListener implements Transcriber {
  readonly supported = speechSupported
  private rec: any = null
  private track: MediaStreamTrack | null = null
  private userMuted = false
  private talking = false // mid-utterance: interim words seen, final not yet in
  private playing = false
  private spawnedAt = 0
  private rapidDeaths = 0 // consecutive spawns that died almost immediately
  private gen = 0
  private meter: ReturnType<typeof setInterval> | null = null
  private backoff: ReturnType<typeof setTimeout> | null = null
  private bars = new Float32Array(8)

  private barge = new BargeInGate({
    floor: SPEECH_FLOOR,
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h),
  })

  private restart = new RestartPolicy(
    {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h),
      delayMs: RESTART_DELAY_MS,
    },
    (gen) => this.spawn(gen),
  )

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
  /** It was a cough: the hold ran its silence out with no words. Resume. */
  onFalseStart: () => void = () => {}
  onError: (msg: string) => void = () => {}
  /** Text currently playing through the speakers, for echo rejection. */
  getSpokenText: () => string = () => ''
  /**
   * That plus whatever played in the last few seconds. Recognition finalizes late,
   * so by the time an echo arrives the audio it came from is already over.
   */
  getRecentSpokenText: () => string = () => ''

  constructor() {
    this.barge.onHold = () => {
      this.talking = true
      this.onSpeechStart()
    }
    this.barge.onRelease = () => {
      this.talking = false
      this.onFalseStart()
    }
  }

  /**
   * Recognition runs on our own echo-cancelled capture rather than the implicit one
   * Chrome opens for itself. That is the whole speakerphone story: without the
   * cancelled stream the mic hears the narration as clearly as it hears the user,
   * the transcript is a mixture of both, and isEcho() below throws away the result.
   */
  async start() {
    if (!speechSupported) return
    this.rapidDeaths = 0 // a fresh start (mic re-enabled) retries from a clean slate
    this.gen = this.restart.start() // refuses a second start; spawn() does the work
    if (this.meter === null) {
      this.meter = setInterval(() => this.level(readLevels('mic', this.bars)), LEVEL_INTERVAL_MS)
    }
  }

  stop() {
    this.gen = this.restart.stop()
    this.talking = false
    this.barge.reset() // a hold outliving the mic releases rather than stranding the book
    if (this.meter !== null) clearInterval(this.meter)
    this.meter = null
    if (this.backoff !== null) clearTimeout(this.backoff)
    this.backoff = null
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

  /** Narration state: only playback can be barged in on. */
  setPlaying(playing: boolean) {
    this.playing = playing
  }

  /**
   * One normalized 0..1 mic level. The meter feeds this every 80ms; it is public
   * so the check can drive the barge-in without a microphone.
   */
  level(v: number) {
    if (this.userMuted) return
    this.barge.level(v, this.playing)
  }

  private spawn(gen: number) {
    // The capture is the async gap the policy's `starting` lock covers: without it
    // a second start() while getUserMedia is prompting spawns two recognizers.
    void (async () => {
      if (!this.track) {
        try {
          this.track = (await getMicStream()).getAudioTracks()[0] ?? null
        } catch (e) {
          this.track = null
          console.warn('mic capture unavailable; recognition falls back to the default device', e)
        }
        if (!this.restart.shouldSpawn(gen)) return // stop() landed while we were awaiting
      }
      this.open(gen)
    })()
  }

  private open(gen: number) {
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

      const recent = this.getRecentSpokenText()
      const partial = interim.trim()
      if (partial && confident(interimConf) && !isEcho(partial, recent)) {
        // Every credible partial goes out. Transport commands are one or two words,
        // so they never reach the ducking threshold below, and Chrome only finalizes
        // an utterance after a beat of trailing silence — waiting for that put a
        // second between "stop" and anything happening. The consumer acts only on
        // partials that can't mean anything else.
        this.barge.words() // the turn is real; the hold is the caller's now
        this.onInterim(partial)
        // The level gate fires ~160ms in; this is the fallback for a start it missed.
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
      // A final that is part narration and part user keeps its user half: dropping
      // the whole line loses the command (echo.ts).
      const kept = isEcho(heard, recent) ? stripEcho(heard, recent) : heard
      if (!kept) return
      this.barge.words()
      this.onUtterance(kept)
    }

    rec.onerror = (e: any) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        this.stop()
        this.onError('Microphone access denied')
        return
      }
      // 'no-speech'/'aborted' are routine; onend restarts. They do end the
      // utterance, though: `talking` stuck true here killed barge-in for the
      // rest of the session.
      if (e.error === 'no-speech' || e.error === 'aborted') {
        this.talking = false
        this.barge.reset()
      }
    }

    rec.onend = () => {
      if (!this.restart.shouldSpawn(gen)) return // an end from a session that is over
      this.talking = false
      this.barge.reset()
      // Chrome stops recognition periodically; the policy restarts it. A healthy
      // session runs for a while before ending — one that dies within a second of
      // starting (recognition service unreachable, mic gone) would respawn in a
      // hot loop forever, invisibly. Back off on those, and after a sustained run
      // of them stop and say so: the mic button flipping off is the honest signal,
      // and tapping it retries.
      const rapid = Date.now() - this.spawnedAt < RAPID_DEATH_MS
      this.rapidDeaths = rapid ? this.rapidDeaths + 1 : 0
      if (this.rapidDeaths >= MAX_RAPID_DEATHS) {
        this.stop()
        this.onError('Voice recognition keeps failing — tap the mic to try again')
        return
      }
      if (!rapid) return this.restart.ended(gen)
      // The policy owns the respawn; the backoff is the extra wait before handing
      // it over. stop() clears this timer, and the generation makes a late
      // hand-over a no-op anyway.
      if (this.backoff !== null) clearTimeout(this.backoff)
      this.backoff = setTimeout(
        () => {
          this.backoff = null
          this.restart.ended(gen)
        },
        Math.min(RESTART_DELAY_MS * 2 ** this.rapidDeaths, MAX_BACKOFF_MS),
      )
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
    this.restart.started(gen)
  }
}
