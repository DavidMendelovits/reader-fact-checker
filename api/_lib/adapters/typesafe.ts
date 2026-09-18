// TypeSafe AI's Jev as Decider. Jev is a "System One" model: it answers typed
// questions about a state with a label and calibrated probabilities, in the
// order of a hundred milliseconds, and never generates text. The HTTP shape is
// the SDK's (POST /v1/systemone, bearer key, {model, state, questions}); the
// SDK itself is not a dependency because this is the whole of it.
import type { Decider, DecisionAnswer, DecisionQuestion } from '../ports.js'

export interface TypeSafeOptions {
  apiKey?: string
  /** Overridable so the self-check can stand in a fake vendor. */
  baseUrl?: string
  model: string
  /** A decision that takes longer than this is slower than the model it was meant to spare. */
  timeoutMs?: number
}

export function typesafeDecider(opts: TypeSafeOptions): Decider {
  return {
    name: 'typesafe',

    async decide(state, questions) {
      const apiKey = opts.apiKey ?? process.env.TYPESAFE_API_KEY
      if (!apiKey) throw new Error('TYPESAFE_API_KEY is not set on the server')
      const base = (opts.baseUrl ?? process.env.TYPESAFE_BASE_URL ?? 'https://api.typesafe.ai').replace(/\/+$/, '')
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 3000)
      try {
        const res = await fetch(`${base}/v1/systemone`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model: opts.model, state, questions }),
          signal: controller.signal,
        })
        if (!res.ok) throw new Error(`TypeSafe failed (${res.status}): ${(await res.text()).slice(0, 300)}`)
        const body = (await res.json()) as { answers?: Record<string, Partial<DecisionAnswer> & { type?: string }> }
        if (!body.answers || typeof body.answers !== 'object') throw new Error('TypeSafe returned no answers')
        return parseAnswers(body.answers, questions)
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

/** Only what was asked, in the shape that was asked; a label outside the offered ones is an error, not a choice. */
export function parseAnswers(
  raw: Record<string, Partial<DecisionAnswer> & { type?: string }>,
  questions: Record<string, DecisionQuestion>,
): Record<string, DecisionAnswer> {
  const out: Record<string, DecisionAnswer> = {}
  for (const [name, q] of Object.entries(questions)) {
    const a = raw[name]
    if (!a) throw new Error(`TypeSafe answered nothing for "${name}"`)
    if (q.type === 'choice') {
      const choice = (a as { choice?: unknown }).choice
      const confidence = Number((a as { confidence?: unknown }).confidence)
      const probabilities = ((a as { probabilities?: unknown }).probabilities ?? {}) as Record<string, number>
      if (typeof choice !== 'string' || !(choice in q.criteria)) throw new Error(`TypeSafe chose "${String(choice)}", which was not offered for "${name}"`)
      out[name] = { type: 'choice', choice, confidence: Number.isFinite(confidence) ? confidence : 0, probabilities }
    } else {
      const noul = Number((a as { noul?: unknown }).noul)
      if (!Number.isFinite(noul)) throw new Error(`TypeSafe returned no probability for "${name}"`)
      out[name] = { type: 'noul', noul }
    }
  }
  return out
}
