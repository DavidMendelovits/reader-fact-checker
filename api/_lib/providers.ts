// Composition root. The one place that knows which vendor stands behind each
// port, chosen from env. Adding a provider is a new file in ./adapters and one
// entry in the registry below; nothing else in the app changes.
//
//   AGENT_PROVIDER      conversation   anthropic (default)
//   CLAIMS_PROVIDER     json           anthropic (default)
//   FACTCHECK_PROVIDER  search         perplexity (default)
//   TTS_PROVIDER        speech         elevenlabs if ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID
//                                      are set, else unreal if UNREAL_SPEECH_API_KEY is, else openai
//   DECIDER_PROVIDER    decider        typesafe if TYPESAFE_API_KEY is set, else none (no fast navigation)
//   LIBRARY_PROVIDER    library        readwise (default), with the caller's own token
//
// Every port but the decider also has `fake` (./adapters/fake.ts), for the
// end-to-end test environment: `npm run dev:e2e` sets all of them (.env.e2e).
// Unit and integration tests don't use it; they mock a port with override().
//
// Instances are built lazily and memoized per name, so a request never pays for
// a client it doesn't use, and a test can point env at a fake before first use.
import type { ConversationModel, Decider, JsonCompletion, SearchModel, SpeechSynthesizer } from './ports.js'
import { anthropicAdapter } from './adapters/anthropic.js'
import { perplexityAdapter } from './adapters/perplexity.js'
import { openaiSpeech } from './adapters/openai-speech.js'
import { unrealSpeech } from './adapters/unreal-speech.js'
import { elevenlabsSpeech } from './adapters/elevenlabs-speech.js'
import { typesafeDecider } from './adapters/typesafe.js'
import { fakeConversation, fakeJson, fakeLibrary, fakeSearch, fakeSpeech } from './adapters/fake.js'
import { meteredConversation, meteredDecider, meteredJson, meteredSearch, meteredSpeech } from './meter.js'
import { readwiseLibrary } from '../../shared/library/readwise.js'
import type { Library } from '../../shared/library/types.js'

export interface Providers {
  conversation: ConversationModel
  json: JsonCompletion
  search: SearchModel
  speech: SpeechSynthesizer
  /** Null when nothing is configured: the feature it backs is skipped, not broken. */
  decider: Decider | null
  /**
   * The reader's library, opened with their own token. The token comes with
   * each request and is never stored here: the routes are open for now, and a
   * library behind a server-held token would be anyone's to read.
   */
  library: (token: string | null) => Library
}

/** A library call with no token where the provider needs one. */
export class NoLibraryToken extends Error {}

const anthropic = () =>
  anthropicAdapter({
    chatModel: process.env.AGENT_MODEL ?? 'claude-sonnet-5',
    jsonModel: process.env.CLAIMS_MODEL ?? 'claude-sonnet-5',
  })

type Factory<T> = () => T
const registry = {
  conversation: { anthropic, fake: fakeConversation } as Record<string, Factory<ConversationModel>>,
  json: { anthropic, fake: fakeJson } as Record<string, Factory<JsonCompletion>>,
  search: {
    perplexity: () => perplexityAdapter({ model: process.env.FACTCHECK_MODEL ?? 'sonar' }),
    fake: () => fakeSearch(),
  } as Record<string, Factory<SearchModel>>,
  speech: {
    openai: () => openaiSpeech({ model: 'gpt-4o-mini-tts', voice: process.env.OPENAI_TTS_VOICE ?? 'nova' }),
    unreal: () => unrealSpeech({ voice: process.env.UNREAL_SPEECH_VOICE ?? 'Sierra' }),
    elevenlabs: () =>
      elevenlabsSpeech({ voiceId: process.env.ELEVENLABS_VOICE_ID ?? '', model: process.env.ELEVENLABS_MODEL ?? 'eleven_v4_turbo' }),
    fake: fakeSpeech,
  } as Record<string, Factory<SpeechSynthesizer>>,
  decider: {
    typesafe: () => typesafeDecider({ model: process.env.TYPESAFE_MODEL ?? 'jev-latest' }),
  } as Record<string, Factory<Decider>>,
  library: {
    readwise: () => (token: string | null) => {
      if (!token) throw new NoLibraryToken('No Readwise token. Add yours in the app to use your library.')
      return readwiseLibrary(token, { maxRetryWait: 20 }) // under api/library.ts's 30s maxDuration
    },
    fake: () => fakeLibrary,
  } as Record<string, Factory<(token: string | null) => Library>>,
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
  if (env('TTS_PROVIDER')) return env('TTS_PROVIDER')!
  if (process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_VOICE_ID) return 'elevenlabs'
  return process.env.UNREAL_SPEECH_API_KEY ? 'unreal' : 'openai'
}

function deciderProvider(): string | null {
  const name = env('DECIDER_PROVIDER') ?? (process.env.TYPESAFE_API_KEY ? 'typesafe' : 'none')
  return name === 'none' ? null : name
}

const overrides: Partial<Providers> = {}

// Each port is handed out metered (./meter.ts), fakes and overrides included, so a
// test sees the same events production logs. The wrappers hold no state, so a
// new one per access costs nothing.

/** The live wiring. Env is read on every access, so a switch needs no restart of the process' state. */
export function providers(): Providers {
  return {
    get conversation() {
      return meteredConversation(overrides.conversation ?? pick('conversation', env('AGENT_PROVIDER') ?? 'anthropic'))
    },
    get json() {
      return meteredJson(overrides.json ?? pick('json', env('CLAIMS_PROVIDER') ?? 'anthropic'))
    },
    get search() {
      return meteredSearch(overrides.search ?? pick('search', env('FACTCHECK_PROVIDER') ?? 'perplexity'))
    },
    get speech() {
      return meteredSpeech(overrides.speech ?? pick('speech', speechProvider()))
    },
    get decider() {
      const name = deciderProvider()
      const d = 'decider' in overrides ? overrides.decider : name ? pick('decider', name) : null
      return d ? meteredDecider(d) : null
    },
    get library() {
      return overrides.library ?? pick('library', env('LIBRARY_PROVIDER') ?? 'readwise')
    },
  }
}

/** For tests: stand a fake behind a port, or pass null to go back to env. */
export function override<K extends keyof Providers>(port: K, impl: Providers[K] | null): void {
  if (impl) overrides[port] = impl
  else delete overrides[port]
}
