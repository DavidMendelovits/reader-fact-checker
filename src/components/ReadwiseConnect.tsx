import { useEffect, useState } from 'react'
import { librarySnapshot, readwiseToken, refreshLibrary, setReadwiseToken } from '../lib/library'

/**
 * Connect a Readwise library so "switch to the Hemingway one" works by voice.
 * The token stays in this browser and rides with each library request.
 */
export function ReadwiseConnect() {
  const [connected, setConnected] = useState(() => readwiseToken() != null)
  const [draft, setDraft] = useState('')
  const [snap, setSnap] = useState(librarySnapshot)
  const [syncing, setSyncing] = useState(false)

  async function sync() {
    setSyncing(true)
    await refreshLibrary()
    setSnap(librarySnapshot())
    setSyncing(false)
  }

  useEffect(() => {
    if (connected) void sync()
  }, [connected])

  if (!connected) {
    return (
      <form
        className="readwise-connect"
        onSubmit={(e) => {
          e.preventDefault()
          if (!draft.trim()) return
          setReadwiseToken(draft)
          setDraft('')
          setConnected(true)
        }}
      >
        <input
          type="password"
          placeholder="Readwise access token, to open your library by voice"
          aria-label="Readwise access token"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          autoComplete="off"
        />
        <button type="submit" disabled={!draft.trim()}>Connect</button>
      </form>
    )
  }

  const status = syncing
    ? 'Syncing your Readwise library…'
    : snap.error
      ? `Readwise: ${snap.error}`
      : `Readwise connected · ${snap.docs} document${snap.docs === 1 ? '' : 's'}`
  return (
    <p className="readwise-connect">
      <span className={snap.error && !syncing ? 'error' : undefined}>{status}</span>
      <button
        type="button"
        className="link-button"
        onClick={() => {
          setReadwiseToken(null)
          setSnap(librarySnapshot())
          setConnected(false)
        }}
      >
        Disconnect
      </button>
    </p>
  )
}
