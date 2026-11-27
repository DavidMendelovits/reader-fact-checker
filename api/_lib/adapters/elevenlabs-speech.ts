// ElevenLabs text-to-speech as SpeechSynthesizer, on Eleven v4 Turbo: their
// lowest-latency model (~100ms median to first audio, by their models page),
// streamed as MP3 over chunked HTTP so the browser starts playing at once.
import type { AudioStream, SpeechSynthesizer } from '../ports.js'

/** Unset unless given; each falls back to its env var, read on every call and trimmed. */
export interface ElevenLabsSpeechOptions {
  apiKey?: string
  voiceId?: string
  model?: string
}

const setting = (name: string) => process.env[name]?.trim() || undefined

export function elevenlabsSpeech(opts: ElevenLabsSpeechOptions): SpeechSynthesizer {
  return {
    name: 'elevenlabs',
    mimeType: 'audio/mpeg',
    // ponytail: v4 Turbo takes 100,000 characters a request (their changelog, Nov
    // 23 2026), but ELEVENLABS_MODEL may name an older model; v3 takes 5,000, the
    // lowest on their list. Paragraphs are capped at 12,000, so this costs at most
    // three requests for the longest.
    maxChars: 5000,

    async synthesize(text: string): Promise<AudioStream> {
      const apiKey = opts.apiKey ?? setting('ELEVENLABS_API_KEY')
      const voiceId = opts.voiceId ?? setting('ELEVENLABS_VOICE_ID')
      if (!apiKey) throw new Error('ELEVENLABS_API_KEY is not set on the server')
      if (!voiceId) throw new Error('ELEVENLABS_VOICE_ID is not set on the server')
      const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream?output_format=mp3_44100_128`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'xi-api-key': apiKey },
        body: JSON.stringify({ text, model_id: opts.model ?? setting('ELEVENLABS_MODEL') ?? 'eleven_v4_turbo' }),
      })
      if (!res.ok) throw new Error(`ElevenLabs failed (${res.status}): ${(await res.text()).slice(0, 300)}`)
      if (!res.body) throw new Error('ElevenLabs returned no body')
      return { mimeType: 'audio/mpeg', body: res.body }
    },
  }
}
