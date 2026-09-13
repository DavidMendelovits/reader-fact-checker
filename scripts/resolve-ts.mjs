// Node loader shim for the *.check.ts self-checks.
//
// Server code imports siblings with a `.js` extension because that is what the
// deployed functions need: Vercel compiles each .ts to .js and Node resolves the
// specifier literally at runtime. Locally, with --experimental-strip-types, only
// the .ts exists. This hook maps a relative `./x.js` to `./x.ts` when that is the
// file on disk, and touches nothing else.
//
//   node --experimental-strip-types --import ./scripts/resolve-ts.mjs api/tts.check.ts
import { register } from 'node:module'

register('./resolve-ts-hook.mjs', import.meta.url)
