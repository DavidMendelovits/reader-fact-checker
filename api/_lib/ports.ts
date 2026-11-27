// Ports: what the application needs from the outside world, in the app's own
// terms. One interface per capability, no vendor types. Adapters in ./adapters
// implement them per vendor; ./providers.ts decides which one runs, from env.
// Nothing outside ./adapters imports a vendor SDK or knows a vendor's wire shape.
//
// (This directory starts with an underscore so Vercel doesn't deploy its files
// as functions; the routes in api/*.ts are the only entry points.)

// ---- the conversation ----

/**
 * The transcript's building blocks. `text`, `tool_use` and `tool_result` are the
 * app's own vocabulary — the client renders and persists them. Anything else is
 * an OpaqueBlock: a vendor-specific block (Anthropic's thinking, for one) that the
 * app carries through the transcript untouched because the same vendor may need
 * it back on its next turn. An adapter must drop opaque blocks it doesn't own.
 */
export type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string }
  | OpaqueBlock
export type OpaqueBlock = { type: string } & Record<string, unknown>

export interface Message {
  role: 'user' | 'assistant'
  content: string | Block[]
}

export interface ToolSpec {
  name: string
  description: string
  /** JSON Schema for the tool's input. */
  inputSchema: Record<string, unknown>
}

export interface TurnRequest {
  /** Byte-stable across turns; adapters that can cache a prefix should cache this. */
  system: string
  /** Per-turn state (position, nearby text). Changes every call. */
  context: string
  tools: ToolSpec[]
  messages: Message[]
}

export interface TurnHooks {
  /** A piece of the spoken reply, as generated. */
  onText?: (text: string) => void
  /** The reply's text block closed; what follows is a tool call or the end. */
  onTextEnd?: () => void
}

export interface TurnUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export interface TurnResult {
  content: Block[]
  usage?: TurnUsage
  /** The model that answered, as the vendor names it (prices are per model). */
  model?: string
}

/** A tool-calling chat model that can stream its text. */
export interface ConversationModel {
  readonly name: string
  turn(req: TurnRequest, hooks?: TurnHooks): Promise<TurnResult>
}

// ---- one-shot structured answers ----

export interface JsonRequest {
  system: string
  user: string
  /** JSON Schema the answer must satisfy. */
  schema: Record<string, unknown>
}

/** A model that answers one prompt with one JSON document matching a schema. */
export interface JsonCompletion {
  readonly name: string
  complete(req: JsonRequest): Promise<string>
}

export interface Source {
  title: string
  url: string
}

export interface GroundedResult {
  /** The raw JSON text, as generated. The caller parses it. */
  text: string
  sources: Source[]
}

/**
 * A JsonCompletion that searches the web before answering and says where it
 * looked. `onDelta` streams the text so a caller can act on fields as they close.
 */
export interface SearchModel {
  readonly name: string
  answer(req: JsonRequest, onDelta?: (text: string) => void): Promise<GroundedResult>
}

// ---- the voice ----

export interface AudioStream {
  mimeType: string
  body: ReadableStream<Uint8Array>
}

/** Text in, a streaming audio file out. */
export interface SpeechSynthesizer {
  readonly name: string
  /** Output container. Only MP3 can be stitched across requests (see speech.ts). */
  readonly mimeType: 'audio/mpeg'
  /** Longest text one request may carry, or null for no practical limit. */
  readonly maxChars: number | null
  synthesize(text: string): Promise<AudioStream>
}

// ---- the ear ----

/**
 * What a browser needs to stream the mic straight to a speech-to-text vendor:
 * where to connect and a short-lived credential. The vendor's key stays on the
 * server, and the audio never passes through it.
 */
export interface ListenGrant {
  /** The WebSocket to open, with the model and audio format already in it. */
  url: string
  /** WebSocket subprotocols that carry the credential. */
  protocols: string[]
  /** Seconds the credential is good for opening a connection. */
  expiresIn: number
}

/** Hands out grants for streaming speech recognition. */
export interface SpeechRecognizer {
  readonly name: string
  grant(): Promise<ListenGrant>
}

// ---- decisions ----

/** A question for a decision model: pick one label, or say yes or no. */
export type DecisionQuestion =
  | { type: 'choice'; instructions?: string; criteria: Record<string, string | null> }
  | { type: 'noul'; instructions?: string }

export type DecisionAnswer =
  | { type: 'choice'; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: 'noul'; noul: number }

/**
 * Typed judgments about a state, in one round trip and well under a second:
 * which of these did the reader mean, is this a command or a question. No
 * text comes back, so nothing is parsed. Used where waiting on the
 * conversation model would be a round-trip of silence for a decision that
 * doesn't need its reasoning.
 */
export interface Decider {
  readonly name: string
  decide(state: unknown, questions: Record<string, DecisionQuestion>): Promise<Record<string, DecisionAnswer>>
}

// ---- the meter ----

/**
 * One call to an outside service: how long it took and what it billed. Every
 * port is metered the same way (./meter.ts wraps whatever providers.ts picks),
 * so two vendors behind one port compare on the same numbers.
 */
export interface MeterEvent {
  /**
   * The server's ports, plus what only the browser sees (clientMeter.ts):
   * bargein, how long the narration played over the reader before it ducked;
   * first_audio, from handing a turn to the model to the first sound back.
   */
  port: 'conversation' | 'json' | 'search' | 'speech' | 'decider' | 'listen' | 'bargein' | 'first_audio'
  provider: string
  /** Set on events the browser reported: which app sent them. */
  client?: 'web' | 'phone'
  model?: string
  /** Until the call settled; for speech, until the audio stream opened. */
  ms: number
  /** Until the first text arrived, for the ports that stream it. */
  firstMs?: number
  ok: boolean
  /** Billed units, where the port reports them: tokens, characters of speech, or seconds of audio heard. */
  units?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; chars?: number; seconds?: number }
  /** US dollars, when the price table knows the model. */
  cost?: number
}

/** Where meter events go. Logs by default; a test or a replay run puts its own here. */
export interface Meter {
  record(event: MeterEvent): void
}
