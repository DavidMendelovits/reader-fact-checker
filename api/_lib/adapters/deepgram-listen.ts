// Deepgram Flux, the streaming speech-to-text behind the browser's ear. The
// server's part is small: trade the key for a short-lived token and say where to
// connect. The browser then streams 16 kHz PCM to Flux itself and reads its
// turn events (src/lib/flux.ts).
//
//   POST https://api.deepgram.com/v1/auth/grant   -> { access_token, expires_in }
//   wss://api.deepgram.com/v2/listen?model=flux-general-en&encoding=linear16&sample_rate=16000
//
// A browser can't set headers on a WebSocket, so the token rides as the
// subprotocol pair ['bearer', token], the form Deepgram's own SDK uses.
import type { SpeechRecognizer } from '../ports.js'

export interface DeepgramListenOptions {
  apiKey?: string
  model?: string
  /** Seconds the token may be used to open a connection. */
  ttlSeconds?: number
}

/** The PCM the browser sends: one channel, 16-bit, 16 kHz, Flux's recommended rate. */
export const LISTEN_SAMPLE_RATE = 16_000

/** Long enough that the grant fetched to check availability still opens the first stream. */
const TTL_SECONDS = 60

const setting = (name: string) => process.env[name]?.trim() || undefined

export function deepgramListen(opts: DeepgramListenOptions): SpeechRecognizer {
  return {
    name: 'deepgram',
    async grant() {
      const ttl = opts.ttlSeconds ?? TTL_SECONDS
      const apiKey = opts.apiKey ?? setting('DEEPGRAM_API_KEY')
      if (!apiKey) throw new Error('DEEPGRAM_API_KEY is not set on the server')
      const res = await fetch('https://api.deepgram.com/v1/auth/grant', {
        method: 'POST',
        headers: { Authorization: `Token ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttl_seconds: ttl }),
      })
      if (!res.ok) throw new Error(`Deepgram grant failed (${res.status}): ${(await res.text()).slice(0, 300)}`)
      const { access_token, expires_in } = (await res.json()) as { access_token?: string; expires_in?: number }
      if (!access_token) throw new Error('Deepgram grant returned no token')
      const query = new URLSearchParams({
        model: opts.model ?? setting('DEEPGRAM_MODEL') ?? 'flux-general-en',
        encoding: 'linear16',
        sample_rate: String(LISTEN_SAMPLE_RATE),
      })
      return { url: `wss://api.deepgram.com/v2/listen?${query}`, protocols: ['bearer', access_token], expiresIn: expires_in ?? ttl }
    },
  }
}
