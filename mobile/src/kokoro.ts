// On-device narration: Kokoro-82M through sherpa-onnx, fully offline.
//
// This is the same model Unreal Speech serves the web app from, so the phone and
// the browser read in one voice — the phone just does it for free, with nothing
// to sync and nothing to cache. The model is fetched once (~90MB for the int8
// build) through the SDK's download manager, which handles the tar.bz2 and
// resumes if the app is backgrounded.
//
// Generation streams: sherpa hands us PCM a sentence at a time and plays it
// through its own player, so audio starts well before the paragraph is done. It
// runs several times faster than real time on a recent phone, which is why the
// end-of-utterance signal below has to be *playback* finishing, not generation.
import { createStreamingTTS } from 'react-native-sherpa-onnx/tts'
import type { StreamingTtsEngine, TtsStreamController } from 'react-native-sherpa-onnx/tts'
import {
  ModelCategory,
  ensureModel,
  isModelDownloaded,
  listModels,
  refreshModels,
  type ModelMeta,
  type Progress,
} from 'react-native-sherpa-onnx/download'
import type { VoiceEngine } from './ports'

// Kokoro's speaker table; 0 is the default American English female voice.
const KOKORO_SPEAKER = 0
// How long to let the player drain past the computed end of the audio. Covers
// the bridge latency between the last writePcmChunk and it actually playing.
const DRAIN_MARGIN_MS = 120

// Prefer the smallest English-capable Kokoro build the release offers; the
// registry is derived from the sherpa-onnx release page, so match by name
// rather than pin an id that could be renamed under us.
const PREFERRED = [/kokoro.*int8.*en/i, /kokoro.*en.*int8/i, /kokoro.*int8/i, /kokoro/i]

let picked: ModelMeta | null = null

async function pickModel(network: boolean): Promise<ModelMeta | null> {
  if (picked) return picked
  let models = await listModels(ModelCategory.Tts) // disk cache; no network
  if (!models.some((m) => /kokoro/i.test(m.id)) && network) {
    models = await refreshModels(ModelCategory.Tts)
  }
  for (const re of PREFERRED) {
    const m = models.find((x) => re.test(x.id))
    if (m) return (picked = m)
  }
  return null
}

/** True when the model is on disk, so the voice can be used without a download. */
export async function isKokoroInstalled(): Promise<boolean> {
  try {
    const model = await pickModel(false)
    return model ? await isModelDownloaded(ModelCategory.Tts, model.id) : false
  } catch {
    return false
  }
}

/** Download the model (idempotent). `onProgress` gets download and extraction phases. */
export async function installKokoro(onProgress?: (p: Progress) => void): Promise<void> {
  const model = await pickModel(true)
  if (!model) throw new Error('No Kokoro model is listed in the sherpa-onnx releases.')
  await ensureModel(ModelCategory.Tts, model.id, { onProgress, deleteArchiveAfterExtract: true })
}

/** Rough download size for the settings row, from the registry entry. */
export async function kokoroSizeMb(): Promise<number | null> {
  const model = await pickModel(true).catch(() => null)
  return model ? Math.round(model.bytes / 1e6) : null
}

type Utterance = {
  finish: (outcome: 'done' | 'stopped') => void
  controller: TtsStreamController | null
  timer: ReturnType<typeof setTimeout> | null
}

export class KokoroVoice implements VoiceEngine {
  private engine: Promise<StreamingTtsEngine> | null = null
  private sampleRate = 24000
  private generation = 0
  private current: Utterance | null = null
  // The teardown of the last utterance, so a speak() that follows a pause()
  // can't start the player before the old stop has finished releasing it.
  private stopping: Promise<void> = Promise.resolve()

  /** Load the model into memory. Called lazily by speak(); call early to hide the cost. */
  ready(): Promise<StreamingTtsEngine> {
    if (!this.engine) {
      this.engine = (async () => {
        const model = await pickModel(false)
        if (!model || !(await isModelDownloaded(ModelCategory.Tts, model.id))) {
          throw new Error('The on-device voice is not installed.')
        }
        const { localPath } = await ensureModel(ModelCategory.Tts, model.id)
        const engine = await createStreamingTTS({
          modelPath: { type: 'file', path: localPath },
          modelType: 'kokoro',
          numThreads: 2,
        })
        this.sampleRate = await engine.getSampleRate()
        return engine
      })()
      this.engine.catch(() => (this.engine = null)) // let the next attempt retry
    }
    return this.engine
  }

  async speak(text: string, rate: number): Promise<'done' | 'stopped'> {
    const engine = await this.ready()
    await this.stop() // one utterance at a time; the player is shared
    const gen = ++this.generation
    await engine.startPcmPlayer(this.sampleRate, 1)

    return new Promise((resolve) => {
      let settled = false
      let startedAt = 0 // when the first samples reached the player
      let queued = 0 // seconds of audio handed to the player so far
      const utt: Utterance = {
        controller: null,
        timer: null,
        finish: (outcome) => {
          if (settled) return
          settled = true
          if (this.current === utt) this.current = null
          resolve(outcome)
        },
      }
      this.current = utt

      engine
        .generateSpeechStream(text, { sid: KOKORO_SPEAKER, speed: rate }, {
          onChunk: (chunk) => {
            if (gen !== this.generation || chunk.samples.length === 0) return
            startedAt ||= Date.now()
            queued += chunk.samples.length / (chunk.sampleRate || this.sampleRate)
            void engine.writePcmChunk(chunk.samples)
          },
          onEnd: (e) => {
            if (gen !== this.generation) return
            if (e.cancelled) return utt.finish('stopped')
            // Generation is done; playback is not. Hold until the queue drains,
            // so the range loop moves the highlight when the words actually end.
            const remaining = startedAt ? startedAt + queued * 1000 - Date.now() : 0
            utt.timer = setTimeout(() => {
              void engine.stopPcmPlayer().catch(() => {})
              utt.finish('done')
            }, Math.max(0, remaining) + DRAIN_MARGIN_MS)
          },
          onError: (err) => {
            if (gen !== this.generation) return
            console.warn('kokoro: generation failed', err.message)
            void engine.stopPcmPlayer().catch(() => {})
            utt.finish('done') // a bad utterance shouldn't wedge the range
          },
        })
        .then(
          (controller) => {
            utt.controller = controller
            if (settled) void controller.cancel().catch(() => {})
          },
          (e) => {
            console.warn('kokoro: could not start generation', e)
            void engine.stopPcmPlayer().catch(() => {})
            utt.finish('done')
          },
        )
    })
  }

  async stop(): Promise<void> {
    const utt = this.current
    if (utt) {
      // cleared synchronously, so a second stop() while this one is in flight
      // is a no-op that still waits for it below
      this.generation++
      this.current = null
      if (utt.timer) clearTimeout(utt.timer)
      this.stopping = (async () => {
        const engine = await this.engine?.catch(() => null)
        try {
          if (utt.controller) await utt.controller.cancel()
          else await engine?.cancelSpeechStream()
        } catch {
          /* nothing to cancel */
        }
        await engine?.stopPcmPlayer().catch(() => {})
        utt.finish('stopped')
      })()
    }
    await this.stopping
  }
}
