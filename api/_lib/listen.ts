// /api/listen: a grant the browser opens its speech-to-text stream with, or null
// when no streaming vendor is configured and the browser keeps its own recognizer.
import type { ListenGrant } from './ports.js'
import { providers } from './providers.js'

export async function listenGrant(): Promise<ListenGrant | null> {
  const r = providers().listen
  return r ? r.grant() : null
}
