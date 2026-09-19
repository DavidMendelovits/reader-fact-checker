// Unreal Speech (hosted Kokoro) as SpeechSynthesizer. About a third the price
// per hour of narration of the alternatives, ~300ms to first audio. Their
// streaming endpoint takes 1,000 characters a call; `maxChars` says so, and the
// stitching in ../speech.ts turns a longer paragraph into several calls and one
// continuous MP3. This adapter only ever sees one piece.
import type { AudioStream, SpeechSynthesizer } from '../ports.js'

export interface UnrealSpeechOptions {
  apiKey?: string
  /** Overridable so the self-check can stand in a fake vendor. */
  baseUrl?: string
  voice: string
}

export function unrealSpeech(opts: UnrealSpeechOptions): SpeechSynthesizer {
  return {
    name: 'unreal',
    mimeType: 'audio/mpeg',
    maxChars: 1000,

    async synthesize(text: string): Promise<AudioStream> {
      const apiKey = opts.apiKey ?? process.env.UNREAL_SPEECH_API_KEY
      if (!apiKey) throw new Error('UNREAL_SPEECH_API_KEY is not set on the server')
      const base = opts.baseUrl ?? process.env.UNREAL_SPEECH_BASE_URL ?? 'https://api.v8.unrealspeech.com'
      const res = await fetch(`${base}/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ Text: text, VoiceId: opts.voice, Bitrate: '128k' }),
      })
      if (!res.ok) throw new Error(`Unreal Speech failed (${res.status}): ${(await res.text()).slice(0, 300)}`)
      if (!res.body) throw new Error('Unreal Speech returned no body')
      return { mimeType: 'audio/mpeg', body: res.body }
    },
  }
}
