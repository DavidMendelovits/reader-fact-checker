// The ElevenLabs adapter: what it sends the vendor, and when providers() picks it.
// A stubbed fetch stands in for the vendor; no request leaves the process.
import assert from 'node:assert/strict'
import { describe, it, vi } from 'vitest'
import { elevenlabsSpeech } from './elevenlabs-speech.ts'
import { providers } from '../providers.ts'

describe('elevenlabsSpeech', () => {
  it('streams MP3 from the voice\'s stream endpoint with the key, text and model', async () => {
    const seen: { url: string; init: RequestInit }[] = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      seen.push({ url, init })
      return new Response('mp3', { status: 200 })
    })
    const synth = elevenlabsSpeech({ apiKey: 'k', voiceId: 'voice 1', model: 'eleven_v4_turbo' })
    const { mimeType, body } = await synth.synthesize('Hello.')
    assert.equal(mimeType, 'audio/mpeg')
    assert.equal(await new Response(body).text(), 'mp3')
    assert.equal(seen[0].url, 'https://api.elevenlabs.io/v1/text-to-speech/voice%201/stream?output_format=mp3_44100_128')
    assert.equal((seen[0].init.headers as Record<string, string>)['xi-api-key'], 'k')
    assert.deepEqual(JSON.parse(String(seen[0].init.body)), { text: 'Hello.', model_id: 'eleven_v4_turbo' })
  })

  it('reads its settings from env on each call, trimmed, defaulting to v4 Turbo', async () => {
    const seen: string[] = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      seen.push(`${url} ${(init.headers as Record<string, string>)['xi-api-key']} ${JSON.parse(String(init.body)).model_id}`)
      return new Response('mp3')
    })
    const synth = elevenlabsSpeech({})
    vi.stubEnv('ELEVENLABS_API_KEY', ' k\n')
    vi.stubEnv('ELEVENLABS_VOICE_ID', 'v1\n')
    await synth.synthesize('x')
    vi.stubEnv('ELEVENLABS_VOICE_ID', 'v2')
    vi.stubEnv('ELEVENLABS_MODEL', 'eleven_flash_v2_5')
    await synth.synthesize('x')
    assert.deepEqual(seen.map((s) => s.replace('https://api.elevenlabs.io/v1/text-to-speech/', '').replace('/stream?output_format=mp3_44100_128', '')), [
      'v1 k eleven_v4_turbo',
      'v2 k eleven_flash_v2_5',
    ])
  })

  it('says which setting is missing, and passes on what the vendor said', async () => {
    vi.stubEnv('ELEVENLABS_API_KEY', '  ')
    vi.stubEnv('ELEVENLABS_VOICE_ID', '')
    await assert.rejects(elevenlabsSpeech({ voiceId: 'v', model: 'm' }).synthesize('x'), /ELEVENLABS_API_KEY/)
    await assert.rejects(elevenlabsSpeech({ apiKey: 'k' }).synthesize('x'), /ELEVENLABS_VOICE_ID/)
    vi.stubGlobal('fetch', async () => new Response('quota exceeded', { status: 401 }))
    await assert.rejects(elevenlabsSpeech({ apiKey: 'k', voiceId: 'v', model: 'm' }).synthesize('x'), /ElevenLabs failed \(401\): quota exceeded/)
  })
})

describe('choosing the voice', () => {
  const pick = () => providers().speech.name

  it('is ElevenLabs once its key and voice are both set, ahead of Unreal', () => {
    vi.stubEnv('TTS_PROVIDER', '')
    vi.stubEnv('UNREAL_SPEECH_API_KEY', 'u')
    vi.stubEnv('ELEVENLABS_API_KEY', 'e')
    vi.stubEnv('ELEVENLABS_VOICE_ID', '\n')
    assert.equal(pick(), 'unreal', 'a key without a voice is not enough')
    vi.stubEnv('ELEVENLABS_VOICE_ID', 'v')
    assert.equal(pick(), 'elevenlabs')
    vi.stubEnv('TTS_PROVIDER', 'openai')
    assert.equal(pick(), 'openai', 'TTS_PROVIDER still wins')
  })
})
