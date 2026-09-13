// Perplexity as SearchModel. Search *is* the product there: retrieval happens
// inside one inference pass, which is most of why a verdict lands in seconds
// rather than tens of seconds through an agentic search-then-read loop.
import type { GroundedResult, JsonRequest, SearchModel, Source } from '../ports.js'

export interface PerplexityOptions {
  apiKey?: string
  model: string
}

/**
 * Perplexity streams SSE: `data: {json}` per chunk, terminated by `data: [DONE]`.
 * Content arrives as OpenAI-style deltas; sources ride along on the chunks as
 * `search_results` (objects) or, on older responses, `citations` (bare URLs).
 */
function readChunk(json: string, sources: Source[], seen: Set<string>): string {
  const chunk = JSON.parse(json) as {
    choices?: { delta?: { content?: string }; message?: { content?: string } }[]
    search_results?: { title?: string; url?: string }[]
    citations?: string[]
  }
  for (const r of chunk.search_results ?? []) {
    if (r.url && !seen.has(r.url)) {
      seen.add(r.url)
      sources.push({ title: r.title || r.url, url: r.url })
    }
  }
  for (const url of chunk.citations ?? []) {
    if (url && !seen.has(url)) {
      seen.add(url)
      sources.push({ title: url, url })
    }
  }
  return chunk.choices?.[0]?.delta?.content ?? ''
}

export function perplexityAdapter(opts: PerplexityOptions): SearchModel {
  return {
    name: 'perplexity',

    async answer(req: JsonRequest, onDelta: (text: string) => void = () => {}): Promise<GroundedResult> {
      const apiKey = opts.apiKey ?? process.env.PERPLEXITY_API_KEY
      if (!apiKey) throw new Error('PERPLEXITY_API_KEY is not set on the server')
      const started = Date.now()
      let firstText = 0

      const res = await fetch('https://api.perplexity.ai/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: opts.model,
          stream: true,
          messages: [
            { role: 'system', content: req.system },
            { role: 'user', content: req.user },
          ],
          // Enforced server-side, so the response is always valid JSON. Asked for
          // in prose instead, citation markup leaked into the string values.
          //
          // Note for anyone tuning the streamed-verdict path: Perplexity does NOT
          // emit properties in declaration order — measured, it sorts them
          // alphabetically. Rename a field and the wire order moves.
          response_format: { type: 'json_schema', json_schema: { schema: req.schema } },
        }),
      })
      if (!res.ok) throw new Error(`Perplexity failed (${res.status}): ${(await res.text()).slice(0, 300)}`)
      if (!res.body) throw new Error('Perplexity returned no body')

      const sources: Source[] = []
      const seen = new Set<string>()
      let text = ''
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        // SSE events are blank-line separated; keep the trailing partial for next read
        const events = buffer.split('\n\n')
        buffer = events.pop() ?? ''
        for (const event of events) {
          const json = event
            .split('\n')
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trim())
            .join('')
          if (!json || json === '[DONE]') continue
          let delta = ''
          try {
            delta = readChunk(json, sources, seen)
          } catch {
            continue // a malformed chunk is not worth failing the whole verdict over
          }
          if (!delta) continue
          firstText ||= Date.now()
          text += delta
          onDelta(delta)
        }
      }

      // Perplexity searches before it writes a byte, so time-to-first-text is the
      // retrieval phase and the rest is generation. That split is the whole
      // question behind picking `sonar` vs `sonar-pro` — log it rather than guess.
      console.log(
        `[factcheck] search=${(firstText || Date.now()) - started}ms write=${firstText ? Date.now() - firstText : 0}ms ` +
          `total=${Date.now() - started}ms sources=${sources.length} model=${opts.model}`,
      )
      return { text, sources }
    },
  }
}
