import { defineConfig } from 'vitest/config'

// Unit and integration tests for the web app, the API and shared/. Every vendor
// is mocked at its port (api/_lib/ports.ts) or with vi.fn, and test/no-network.ts
// fails any socket that leaves the machine.
export default defineConfig({
  test: {
    include: ['{api,src,shared,test}/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['test/no-network.ts'],
    restoreMocks: true,
    unstubGlobals: true,
    unstubEnvs: true,
  },
})
