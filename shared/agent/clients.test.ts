// Each kit's tools are offered to the model by the server, but run on the device.
// A tool offered with no handler on its client would fail mid-conversation.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'vitest'
import { CLIENT_KITS, type ClientId } from './clients.ts'

// ponytail: reads the handler map out of each client's source rather than
// importing it; the two agent modules pull in a browser and a phone runtime
const SOURCES: Record<ClientId, string> = { web: 'src/lib/agent.ts', phone: 'mobile/src/agent.ts' }

function handlerNames(file: string): string[] {
  const src = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')
  const block = src.match(/\n\s*tools: \{([^}]*)\}/)
  assert.ok(block, `no tools map in ${file}`)
  return [...block[1].matchAll(/([a-z_]+)\s*[:,]/g)].map((m) => m[1])
}

describe('the client kits', () => {
  for (const id of Object.keys(CLIENT_KITS) as ClientId[]) {
    it(`each ${id} tool has a handler on the ${id} client`, () => {
      const names = handlerNames(SOURCES[id])
      for (const tool of CLIENT_KITS[id].tools) assert.ok(names.includes(tool.name), `${tool.name} has no handler in ${SOURCES[id]}`)
    })
  }
})
