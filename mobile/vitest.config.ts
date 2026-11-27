import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const stub = (name: string) => fileURLToPath(new URL(`./test/stubs/${name}.ts`, import.meta.url))

// The phone app's unit tests. Native modules are swapped for the small stubs in
// test/stubs (react-native's Flow sources don't load under node), and the
// repo's no-network guard fails any socket that leaves the machine.
export default defineConfig({
  resolve: {
    alias: {
      'react-native': stub('react-native'),
      '@react-native-async-storage/async-storage': stub('async-storage'),
      'expo-secure-store': stub('expo-secure-store'),
      'expo-speech-recognition': stub('expo-speech-recognition'),
      'expo-speech': stub('expo-speech'),
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['../test/no-network.ts'],
    restoreMocks: true,
    unstubGlobals: true,
  },
})
