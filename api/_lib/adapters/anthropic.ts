// Anthropic Messages API as ConversationModel (the reading companion) and
// JsonCompletion (claim extraction). The app's Block vocabulary is a subset of
// Anthropic's content blocks, so the transcript passes through unchanged in both
// directions; thinking blocks ride along as OpaqueBlocks and come back intact,
// which the API requires when a tool-use turn continues.
import Anthropic from '@anthropic-ai/sdk'
import type {
  Block,
  ConversationModel,
  JsonCompletion,
  JsonRequest,
  TurnHooks,
  TurnRequest,
  TurnResult,
} from '../ports.js'

export interface AnthropicOptions {
  apiKey?: string
  /** The conversation. */
  chatModel: string
  /** One-shot JSON answers. */
  jsonModel: string
}

export function anthropicAdapter(opts: AnthropicOptions): ConversationModel & JsonCompletion {
  let client: Anthropic | null = null
  const sdk = () => {
    if (!client) {
      const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY
      if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set on the server')
      client = new Anthropic({ apiKey })
    }
    return client
  }

  return {
    name: 'anthropic',

    async turn(req: TurnRequest, hooks: TurnHooks = {}): Promise<TurnResult> {
      const stream = sdk().messages.stream({
        model: opts.chatModel,
        max_tokens: 2048,
        // Low effort: a voice companion's turns are one line and a tool call.
        // Sonnet 5 defaults to high, which spends seconds thinking before the
        // first spoken word.
        output_config: { effort: 'low' },
        system: [
          // the static half caches (with the tools) behind this breakpoint; only
          // the per-turn context after it is reprocessed
          { type: 'text', text: req.system, cache_control: { type: 'ephemeral' } },
          { type: 'text', text: req.context },
        ],
        tools: req.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema as Anthropic.Tool['input_schema'],
        })),
        messages: req.messages as unknown as Anthropic.MessageParam[],
      })

      let inText = false
      for await (const event of stream) {
        if (event.type === 'content_block_start') {
          inText = event.content_block.type === 'text'
        } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          hooks.onText?.(event.delta.text)
        } else if (event.type === 'content_block_stop' && inText) {
          inText = false
          hooks.onTextEnd?.()
        }
      }
      const response = await stream.finalMessage()
      const u = response.usage
      return {
        content: response.content as unknown as Block[],
        usage: {
          input: u.input_tokens,
          output: u.output_tokens,
          cacheRead: u.cache_read_input_tokens ?? 0,
          cacheWrite: u.cache_creation_input_tokens ?? 0,
        },
      }
    },

    async complete(req: JsonRequest): Promise<string> {
      const response = await sdk().messages.create({
        model: opts.jsonModel,
        max_tokens: 2048,
        output_config: { effort: 'low', format: { type: 'json_schema', schema: req.schema } },
        system: req.system,
        messages: [{ role: 'user', content: req.user }],
      })
      return response.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('')
    },
  }
}
