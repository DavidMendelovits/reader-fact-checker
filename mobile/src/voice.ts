// Continuous speech input on expo-speech-recognition, mirroring the web
// VoiceListener (src/lib/voice.ts): no wake word, mic live during narration,
// the shared isEcho()/stripEcho() throwing away the recognizer's transcription
// of the narration itself.
// iOS voice processing (AEC) is the native upgrade the web version could only
// wish for — the speakerphone story mostly just works here.
//
// Three policies are shared with the web listener and checked next to themselves:
// BargeInGate decides when the user is audibly talking, RestartPolicy decides who
// may respawn the recognizer, and echo.ts decides what was the book talking. What
// is left here is the platform: events in, callbacks out.
import {
  ExpoSpeechRecognitionModule,
  type ExpoSpeechRecognitionErrorEvent,
  type ExpoSpeechRecognitionResultEvent,
} from 'expo-speech-recognition'
import { getMicLevel, setMicLevel } from './levels.ts'
import type { Transcriber } from './ports.ts'
import { BargeInGate } from '../../shared/voice/bargeIn.ts'
import { isEcho, stripEcho } from '../../shared/voice/echo.ts'
import { RestartPolicy } from '../../shared/voice/restartPolicy.ts'

const words = (s: string) => s.toLowerCase().match(/[a-z0-9']+/g) ?? []
const countWords = (s: string) => words(s).length

const MIN_INTERIM_WORDS = 3

/** Respawn delay after a routine `end`; the OS tears recognition down often. */
const RESTART_DELAY_MS = 250
/** A session that ends this soon after starting never really ran. */
const RAPID_DEATH_MS = 1000
const DEATH_WINDOW_MS = 30000
const MAX_RAPID_DEATHS = 3

export class VoiceListener implements Transcriber {
  private talking = false
  private playing = false
  private granted = false
  private gen = 0
  private spawnedAt = 0
  /** Timestamps of sessions that died on arrival, inside the window. */
  private rapidDeaths: number[] = []
  private subs: { remove(): void }[] = []
  /** Which native session is the live one; an end from an older one is stale. */
  private session = 0
  /** The `end` listener of the session that is running, bound to it. */
  private endSub: { remove(): void } | null = null
  /** A native session is live: a stale event must not start a second one. */
  private live = false

  private barge = new BargeInGate({
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

  onUtterance: (text: string) => void = () => {}
  onInterim: (text: string) => void = () => {}
  onSpeechStart: () => void = () => {}
  onFalseStart: () => void = () => {}
  onError: (msg: string) => void = () => {}
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

  async start() {
    this.gen = this.restart.start() // refuses a second start; spawn() does the work
  }

  stop() {
    this.gen = this.restart.stop()
    this.talking = false
    this.live = false
    this.barge.reset() // a hold outliving the mic releases rather than stranding the book
    ExpoSpeechRecognitionModule.stop()
  }

  /** Narration state: only playback can be barged in on. */
  setPlaying(playing: boolean) {
    this.playing = playing
  }

  /**
   * One normalized 0..1 mic level. The volumechange handler feeds this every 80ms;
   * it is public so the check can drive the barge-in without a microphone.
   */
  level(v: number) {
    this.barge.level(v, this.playing)
  }

  private listen() {
    this.subs.push(
      ExpoSpeechRecognitionModule.addListener('result', (event: ExpoSpeechRecognitionResultEvent) => {
        const text = (event.results[0]?.transcript ?? '').trim()
        if (!text) return
        const recent = this.getRecentSpokenText()

        if (event.isFinal) {
          this.talking = false
          // A final that is part narration and part user keeps its user half:
          // dropping the whole line loses the command (echo.ts).
          const heard = isEcho(text, recent) ? stripEcho(text, recent) : text
          if (!heard) return
          // The utterance is over; the gate forgets it so the next one can hold
          // again. It stays held here — words() made it the caller's interruption.
          this.barge.utteranceDone()
          this.onUtterance(heard)
          return
        }

        if (isEcho(text, recent)) return
        this.barge.words()
        // The level gate fires ~160ms in; this is the fallback for a start it missed.
        // It runs *before* onInterim: the interim is what converts a hold into the
        // real interruption, and there is nothing to convert until the hold is taken.
        if (!this.talking && countWords(text) >= MIN_INTERIM_WORDS) {
          this.talking = true
          this.onSpeechStart()
        }
        this.onInterim(text)
      }),
      ExpoSpeechRecognitionModule.addListener('error', (event: ExpoSpeechRecognitionErrorEvent) => {
        if (event.error === 'not-allowed') {
          this.granted = false
          this.stop()
          this.onError('Microphone access denied')
          return
        }
        // 'no-speech'/'aborted' are routine; the end handler respawns. They do end
        // the utterance, though: `talking` stuck true here used to kill barge-in
        // for the rest of the session.
        if (event.error === 'no-speech' || event.error === 'aborted') {
          this.talking = false
          // reset() releases the gate's own hold through onRelease; a hold the word
          // path took is one the gate knows nothing about, and has no other releaser.
          const wasHeld = this.barge.held
          this.barge.reset()
          if (!wasHeld) this.onFalseStart()
        }
      }),
      ExpoSpeechRecognitionModule.addListener('volumechange', (event: { value: number }) => {
        setMicLevel(event.value)
        this.level(getMicLevel())
      }),
    )
  }

  /**
   * `end` for one session. Both tokens are bound when the listener is registered
   * rather than read when the event arrives: a routine restart keeps the same
   * restart generation, so an end that turns up late — after the session it belongs
   * to was replaced — used to respawn the live one out from under itself.
   */
  private ended(gen: number, session: number) {
    if (session !== this.session) return // an end from a session that has been replaced
    if (!this.restart.shouldSpawn(gen)) return // an end from a session that is over
    this.live = false
    this.talking = false
    const wasHeld = this.barge.held
    this.barge.reset()
    if (!wasHeld) this.onFalseStart() // a hold taken by the word path has no other releaser
    if (this.tooManyDeaths()) {
      this.stop()
      this.onError('Voice recognition keeps failing — tap the mic to try again')
      return
    }
    this.restart.ended(gen)
  }

  /**
   * A recognizer that dies the moment it starts (no service, no mic) respawns in a
   * hot loop forever, invisibly. Three of those inside the window and the mic
   * turning itself off is the honest signal; tapping it retries.
   */
  private tooManyDeaths(): boolean {
    const now = Date.now()
    if (now - this.spawnedAt >= RAPID_DEATH_MS) {
      this.rapidDeaths = []
      return false
    }
    this.rapidDeaths = this.rapidDeaths.filter((t) => now - t < DEATH_WINDOW_MS)
    this.rapidDeaths.push(now)
    if (this.rapidDeaths.length < MAX_RAPID_DEATHS) return false
    this.rapidDeaths = [] // the next start() gets a clean slate
    return true
  }

  private spawn(gen: number) {
    this.gen = gen
    // The permission prompt is the async gap the policy's `starting` lock covers:
    // without it a second start() during the prompt spawns two recognizers.
    void (async () => {
      if (!this.granted) {
        this.granted = (await ExpoSpeechRecognitionModule.requestPermissionsAsync()).granted
        if (!this.restart.shouldSpawn(gen)) return
        if (!this.granted) {
          this.stop()
          this.onError('Microphone access denied')
          return
        }
      }
      if (!this.restart.shouldSpawn(gen)) return
      if (this.subs.length === 0) this.listen()
      const session = ++this.session
      this.endSub?.remove()
      this.endSub = ExpoSpeechRecognitionModule.addListener('end', () => this.ended(gen, session))
      if (this.live) return // a stale event must not start a second session
      this.live = true
      this.spawnedAt = Date.now()
      ExpoSpeechRecognitionModule.start({
        lang: 'en-US',
        interimResults: true,
        continuous: true,
        // the level behind the aurora and the barge-in gate; every 80ms
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
      this.restart.started(gen)
    })()
  }
}
