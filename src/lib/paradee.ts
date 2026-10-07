// Paradee: an 8M-parameter distillation of Kokoro-82M (one voice, af_heart,
// Apache-2.0) that runs in the page, so narration costs nothing per character.
// https://huggingface.co/sahilmahendrakar/Paradee-8M-v1.0
//
// Text -> eSpeak NG phonemes the way kokoro-js makes them -> misaki spelling
// (the only spelling Paradee saw in training) -> token ids -> onnxruntime-web ->
// 24 kHz samples -> WAV. The model, eSpeak and onnxruntime all load on the first
// synthesize, so picking the server voice costs nothing.
import type { AudioSource } from './ports.ts'
import { SAMPLE_RATE, chunkPhonemes, encodeWav, splitSentences, toIds } from './paradee-core.ts'

const REPO = 'https://huggingface.co/sahilmahendrakar/Paradee-8M-v1.0/resolve/v1.0'
const MODEL_URL = `${REPO}/onnx/paradee_int8.onnx`
const CONFIG_URL = `${REPO}/config.json`

/** Through the Cache API, keyed by the pinned URL, so a reload doesn't refetch 9 MB. */
async function fetchCached(url: string): Promise<ArrayBuffer> {
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
  try {
    await cache?.put(url, res.clone())
  } catch {
    /* quota or similar; still usable this time */
  }
  return res.arrayBuffer()
}

async function init() {
  const [ort, { phonemize }, { toMisaki }, model, config] = await Promise.all([
    import('onnxruntime-web/wasm'),
    import('./vendor/phonemize.ts'),
    import('./vendor/misaki.ts'),
    fetchCached(MODEL_URL),
    fetchCached(CONFIG_URL),
  ])
  // Inference runs in ort's worker so it never blocks the mic handling; the wasm
  // comes from the CDN at exactly the installed version, so Vite needs no config.
  ort.env.wasm.proxy = true
  ort.env.wasm.wasmPaths = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ort.env.versions.web}/dist/`
  const session = await ort.InferenceSession.create(new Uint8Array(model))
  const vocab: Record<string, number> = JSON.parse(new TextDecoder().decode(config)).vocab
  return { ort, session, vocab, phonemize, toMisaki }
}

let loading: ReturnType<typeof init> | null = null
function load() {
  if (!loading) {
    loading = init()
    loading.catch(() => (loading = null)) // a failed download can be retried
  }
  return loading
}

// One synthesis at a time, in request order: the player prefetches ahead, and
// the paragraph it is waiting on was asked for first.
let queue: Promise<unknown> = Promise.resolve()

async function run(text: string, signal?: AbortSignal): Promise<Response> {
  const { ort, session, vocab, phonemize, toMisaki } = await load()
  const started = performance.now()
  const parts: Float32Array[] = []
  for (const sentence of splitSentences(text)) {
    signal?.throwIfAborted()
    for (const ps of chunkPhonemes(toMisaki(await phonemize(sentence)))) {
      signal?.throwIfAborted()
      const ids = toIds(ps, vocab)
      const out = await session.run({
        input_ids: new ort.Tensor('int64', BigInt64Array.from(ids, BigInt), [1, ids.length]),
        speed: new ort.Tensor('float32', Float32Array.of(1), [1]),
      })
      parts.push(out.waveform.data as Float32Array)
    }
  }
  const wav = encodeWav(parts, SAMPLE_RATE)
  const samples = (wav.byteLength - 44) / 2
  console.log(
    `[tts] provider=paradee chars=${text.length} synth=${Math.round(performance.now() - started)}ms audio=${Math.round((samples / SAMPLE_RATE) * 1000)}ms`,
  )
  return new Response(wav, { headers: { 'Content-Type': 'audio/wav' } })
}

export const paradeeSpeech: AudioSource = {
  buffered: true,
  synthesize(text, signal) {
    const next = queue.then(() => run(text, signal))
    queue = next.catch(() => {})
    return next
  },
}
