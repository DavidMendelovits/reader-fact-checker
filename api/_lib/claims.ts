// Whole-document scan: pull the checkable claims out of a section. The model is
// whatever providers().json says.
import { providers } from './providers.js'

const CLAIMS_SCHEMA = {
  type: 'object',
  properties: { claims: { type: 'array', items: { type: 'string' } } },
  required: ['claims'],
  additionalProperties: false,
} as const

const CLAIMS_SYSTEM =
  'Extract the distinct, independently checkable factual claims from the text. Each claim must be self-contained, with enough context to verify on its own. Max 6 claims; pick the most significant or surprising ones. Skip opinions and common knowledge. If nothing is checkable, return an empty list.'

export async function extractClaims(section: string): Promise<string[]> {
  const text = await providers().json.complete({ system: CLAIMS_SYSTEM, user: section, schema: CLAIMS_SCHEMA })
  try {
    const parsed = JSON.parse(text) as { claims?: unknown }
    return Array.isArray(parsed.claims) ? parsed.claims.filter((c): c is string => typeof c === 'string') : []
  } catch {
    return [] // a bad section shouldn't abort a whole-document scan
  }
}
