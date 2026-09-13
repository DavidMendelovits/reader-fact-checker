// Composition root. The one place that knows which vendor stands behind each
// port, chosen from env. Adding a provider is a new file in ./adapters and one
// entry in the registry below; nothing else in the app changes.
//
//   AGENT_PROVIDER      conversation   anthropic (default)
//   CLAIMS_PROVIDER     json           anthropic (default)
//   FACTCHECK_PROVIDER  search         perplexity (default)
//   TTS_PROVIDER        speech         unreal if UNREAL_SPEECH_API_KEY is set, else openai
//
// Instances are built lazily and memoized per name, so a request never pays for
// a client it doesn't use, and a test can point env at a fake before first use.
import type { ConversationModel, JsonCompletion, SearchModel, SpeechSynthesizer } from './ports.js'
import { anthropicAdapter } from './adapters/anthropic.js'
import { perplexityAdapter } from './adapters/perplexity.js'
import { openaiSpeech } from './adapters/openai-speech.js'
import { unrealSpeech } from './adapters/unreal-speech.js'

export interface Providers {
  conversation: ConversationModel
  json: JsonCompletion
  search: SearchModel
  speech: SpeechSynthesizer
}

const anthropic = () =>
  anthropicAdapter({
    chatModel: process.env.AGENT_MODEL ?? 'claude-sonnet-5',
    jsonModel: process.env.CLAIMS_MODEL ?? 'claude-sonnet-5',
  })

type Factory<T> = () => T
const registry = {
  conversation: { anthropic } as Record<string, Factory<ConversationModel>>,
  json: { anthropic } as Record<string, Factory<JsonCompletion>>,
  search: {
    perplexity: () => perplexityAdapter({ model: process.env.FACTCHECK_MODEL ?? 'sonar' }),
  } as Record<string, Factory<SearchModel>>,
  speech: {
    openai: () => openaiSpeech({ model: 'gpt-4o-mini-tts', voice: process.env.OPENAI_TTS_VOICE ?? 'nova' }),
    unreal: () => unrealSpeech({ voice: process.env.UNREAL_SPEECH_VOICE ?? 'Sierra' }),
  } as Record<string, Factory<SpeechSynthesizer>>,
}

const instances = new Map<string, unknown>()

function pick<K extends keyof typeof registry>(port: K, name: string): ReturnType<(typeof registry)[K][string]> {
  const factory = registry[port][name]
  if (!factory) {
    throw new Error(`Unknown ${port} provider "${name}"; known: ${Object.keys(registry[port]).join(', ')}`)
  }
  const key = `${port}:${name}`
  if (!instances.has(key)) instances.set(key, factory())
  return instances.get(key) as ReturnType<(typeof registry)[K][string]>
}

const env = (name: string) => process.env[name]?.trim().toLowerCase() || undefined

function speechProvider(): string {
  return env('TTS_PROVIDER') ?? (process.env.UNREAL_SPEECH_API_KEY ? 'unreal' : 'openai')
}

const overrides: Partial<Providers> = {}

/** The live wiring. Env is read on every access, so a switch needs no restart of the process' state. */
export function providers(): Providers {
  return {
    get conversation() {
      return overrides.conversation ?? pick('conversation', env('AGENT_PROVIDER') ?? 'anthropic')
    },
    get json() {
      return overrides.json ?? pick('json', env('CLAIMS_PROVIDER') ?? 'anthropic')
    },
    get search() {
      return overrides.search ?? pick('search', env('FACTCHECK_PROVIDER') ?? 'perplexity')
    },
    get speech() {
      return overrides.speech ?? pick('speech', speechProvider())
    },
  }
}

/** For tests: stand a fake behind a port, or pass null to go back to env. */
export function override<K extends keyof Providers>(port: K, impl: Providers[K] | null): void {
  if (impl) overrides[port] = impl
  else delete overrides[port]
}
