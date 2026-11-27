import { loadEnv } from 'vite'
import { defineConfig } from 'vitest/config'

// `npm run replay` only (run.replay.ts). Unlike the suite it may reach the
// network, and it reads .env.local the way `npm run dev` does, so the keys and
// provider choices there apply. run.replay.ts refuses to spend without REPLAY_LIVE=1.
export default defineConfig(({ mode }) => {
  for (const [k, v] of Object.entries(loadEnv(mode, process.cwd(), ''))) process.env[k] ??= v
  return {
    test: {
      include: ['test/replay/run.replay.ts'],
      environment: 'node',
      testTimeout: 30 * 60_000,
    },
  }
})
