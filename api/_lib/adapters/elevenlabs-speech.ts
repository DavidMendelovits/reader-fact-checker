// ElevenLabs text-to-speech as SpeechSynthesizer, on Eleven v4 Turbo: their
// lowest-latency model (~100ms median to first audio, by their models page),
// streamed as MP3 over chunked HTTP so the browser starts playing at once.
import type { AudioStream, SpeechSynthesizer } from '../ports.js'

export interface ElevenLabsSpeechOptions {
  apiKey?: string
  /** Overridable so the self-check can stand in a fake vendor. */
  baseUrl?: string
  voiceId: string
  model: string
}

export function elevenlabsSpeech(opts: ElevenLabsSpeechOptions): SpeechSynthesizer {
  return {
    name: 'elevenlabs',
    mimeType: 'audio/mpeg',
    // ponytail: their models page lists no character cap for v4 Turbo (Flash v2.5
    // takes 40,000, v3 5,000). 5,000 keeps a paragraph to one request and leaves
    // the stitching to cut the rare longer one; raise it once the cap is known.
    maxChars: 5000,

    async synthesize(text: string): Promise<AudioStream> {
      const apiKey = opts.apiKey ?? process.env.ELEVENLABS_API_KEY
      if (!apiKey) throw new Error('ELEVENLABS_API_KEY is not set on the server')
      if (!opts.voiceId) throw new Error('ELEVENLABS_VOICE_ID is not set on the server')
      const base = opts.baseUrl ?? process.env.ELEVENLABS_BASE_URL ?? 'https://api.elevenlabs.io'
      const res = await fetch(`${base}/v1/text-to-speech/${encodeURIComponent(opts.voiceId)}/stream?output_format=mp3_44100_128`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'xi-api-key': apiKey },
        body: JSON.stringify({ text, model_id: opts.model }),
      })
      if (!res.ok) throw new Error(`ElevenLabs failed (${res.status}): ${(await res.text()).slice(0, 300)}`)
      if (!res.body) throw new Error('ElevenLabs returned no body')
      return { mimeType: 'audio/mpeg', body: res.body }
    },
  }
}
