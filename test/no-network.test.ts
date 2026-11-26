import { expect, it } from 'vitest'
import https from 'node:https'

it('blocks fetch to the internet', async () => {
  const err = await fetch('https://example.com/').catch((e: Error) => e)
  expect(String((err as Error & { cause?: unknown }).cause)).toMatch(/blocked/)
})

it('blocks node:https to the internet', () => {
  expect(() => https.get('https://example.com/')).toThrow(/blocked/)
})
