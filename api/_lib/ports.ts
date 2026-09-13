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
