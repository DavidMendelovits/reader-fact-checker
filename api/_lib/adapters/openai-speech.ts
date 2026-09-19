// OpenAI text-to-speech as SpeechSynthesizer. Streams MP3 from the first byte;
// measured on a typical paragraph, first byte lands at ~1.2s and the full clip
// takes ~4.9s, so the caller must pipe rather than buffer.
import type { AudioStream, SpeechSynthesizer } from '../ports.js'

export interface OpenAiSpeechOptions {
  apiKey?: string
  model: string
  voice: string
}

export function openaiSpeech(opts: OpenAiSpeechOptions): SpeechSynthesizer {
  return {
    name: 'openai',
    mimeType: 'audio/mpeg',
    maxChars: 4000,

    async synthesize(text: string): Promise<AudioStream> {
      const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY
      if (!apiKey) throw new Error('OPENAI_API_KEY is not set on the server')
      const res = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: opts.model, voice: opts.voice, input: text }),
      })
      if (!res.ok) throw new Error(`OpenAI TTS failed (${res.status}): ${(await res.text()).slice(0, 300)}`)
      if (!res.body) throw new Error('OpenAI TTS returned no body')
      return { mimeType: 'audio/mpeg', body: res.body }
    },
  }
}
