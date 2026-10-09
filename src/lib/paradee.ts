// Paradee: an 8M-parameter distillation of Kokoro-82M (one voice, af_heart,
// Apache-2.0) that runs in the page, so narration costs nothing per character.
// https://huggingface.co/sahilmahendrakar/Paradee-8M-v1.0
//
// Text -> eSpeak NG phonemes the way kokoro-js makes them -> misaki spelling
// (the only spelling Paradee saw in training) -> token ids -> onnxruntime-web ->
// 24 kHz samples -> WAV. The model, eSpeak and onnxruntime all load on preload()
// or the first synthesize, so picking the server voice costs nothing.
import type { AudioSource } from './ports.ts'
import { SAMPLE_RATE, chunkPhonemes, encodeWav, normalizeText, splitSentences, toIds, trimSilence } from './paradee-core.ts'

const REPO = 'https://huggingface.co/sahilmahendrakar/Paradee-8M-v1.0/resolve/v1.0'
const MODEL_URL = `${REPO}/onnx/paradee_int8.onnx`
const CONFIG_URL = `${REPO}/config.json`

/** Through the Cache API, keyed by the pinned URL, so a reload doesn't refetch 9 MB. */
async function fetchCached(url: string, onProgress?: (fraction: number) => void): Promise<ArrayBuffer> {
  let cache: Cache | undefined
  try {
    cache = await caches.open('paradee')
    const hit = await cache.match(url)
    if (hit) return await hit.arrayBuffer()
  } catch {
    /* no Cache API here (insecure origin, private mode) — plain fetch */
  }
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Paradee download failed (${res.status}): ${url}`)
  const body = await readBody(res, onProgress)
  try {
    await cache?.put(url, new Response(body))
  } catch {
    /* quota or similar; still usable this time */
  }
  return body
}

/** The body, reporting the fraction read when the server sent a Content-Length. */
async function readBody(res: Response, onProgress?: (fraction: number) => void): Promise<ArrayBuffer> {
  const total = Number(res.headers.get('Content-Length'))
  if (!onProgress || !total || !res.body) return res.arrayBuffer()
  const reader = res.body.getReader()
  const chunks: Uint8Array<ArrayBuffer>[] = []
  let received = 0
  for (let r = await reader.read(); !r.done; r = await reader.read()) {
    chunks.push(r.value)
    received += r.value.length
    onProgress(Math.min(1, received / total)) // a compressed body can outrun its length
  }
  return new Blob(chunks).arrayBuffer()
}

async function init() {
  const [ort, { phonemize }, { toMisaki }, model, config] = await Promise.all([
    import('onnxruntime-web/wasm'),
    import('./vendor/phonemize.ts'),
    import('./vendor/misaki.ts'),
    fetchCached(MODEL_URL, (f) => paradeeSpeech.onStatus('loading', f)),
    fetchCached(CONFIG_URL),
  ])
  // the wasm download and compile below can't be measured: indeterminate from here
  paradeeSpeech.onStatus('loading')
  // Inference runs in ort's worker so it never blocks the mic handling; the wasm
  // is the copy Vite emits next to ort's bundle, so it is always the installed version.
  ort.env.wasm.proxy = true
  const session = await ort.InferenceSession.create(new Uint8Array(model))
  const vocab: Record<string, number> = JSON.parse(new TextDecoder().decode(config)).vocab
  return { ort, session, vocab, phonemize, toMisaki }
}

let loading: ReturnType<typeof init> | null = null
function load() {
  if (!loading) {
    paradeeSpeech.onStatus('loading')
    loading = init()
    loading.then(
      () => paradeeSpeech.onStatus('ready'),
      () => {
        loading = null // a failed download can be retried
        paradeeSpeech.onStatus('error')
      },
    )
  }
  return loading
}

// One synthesis at a time, in request order: the player prefetches ahead, and
// the paragraph it is waiting on was asked for first.
let queue: Promise<unknown> = Promise.resolve()

async function run(text: string, signal?: AbortSignal, quiet = false): Promise<Response> {
  const { ort, session, vocab, phonemize, toMisaki } = await load()
  const started = performance.now()
  const parts: Float32Array[] = []
  // before the split, which would otherwise cut a sentence at "e.g."
  for (const sentence of splitSentences(normalizeText(text))) {
    signal?.throwIfAborted()
    for (const ps of chunkPhonemes(toMisaki(await phonemize(sentence)))) {
      signal?.throwIfAborted()
      const ids = toIds(ps, vocab)
      const out = await session.run({
        input_ids: new ort.Tensor('int64', BigInt64Array.from(ids, BigInt), [1, ids.length]),
        speed: new ort.Tensor('float32', Float32Array.of(1), [1]),
      })
      // the model's own padding at both ends reads as a stall between sentences
      parts.push(trimSilence(out.waveform.data as Float32Array, SAMPLE_RATE))
    }
  }
  const wav = encodeWav(parts, SAMPLE_RATE)
  const samples = (wav.byteLength - 44) / 2
  if (!quiet) console.log(
    `[tts] provider=paradee chars=${text.length} synth=${Math.round(performance.now() - started)}ms audio=${Math.round((samples / SAMPLE_RATE) * 1000)}ms`,
  )
  return new Response(wav, { headers: { 'Content-Type': 'audio/wav' } })
}

export const paradeeSpeech: AudioSource & {
  preload(): void
  /** Load status for the Play button: progress is the model download, 0..1, when it can be told. */
  onStatus: (status: 'loading' | 'ready' | 'error', progress?: number) => void
} = {
  buffered: true,
  synthesize(text, signal) {
    const next = queue.then(() => run(text, signal))
    queue = next.catch(() => {})
    return next
  },
  /**
   * Load everything, then synthesize one throwaway word so eSpeak, ort's worker
   * and the wasm JIT are hot before the first real Play. A failure only reaches
   * onStatus; the next synthesize retries the load.
   */
  preload() {
    queue = queue.then(() => run('Hi.', undefined, true)).catch(() => {})
  },
  onStatus: () => {},
}
