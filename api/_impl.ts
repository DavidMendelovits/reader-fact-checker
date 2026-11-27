// Server-side entry point shared by the Vercel functions and the Vite dev
// middleware. The code lives in _lib/: ports.ts says what the app needs,
// adapters/ implement it per vendor, providers.ts picks which one runs, and the
// use-case modules (agent, factcheck, claims, speech, fetch) sit in between.
// Keys come from process.env — never shipped to the browser.
export { agentTurn, agentNdjson, agentRequestProblem, clientOf, type AgentContext } from './_lib/agent.js'
export { factcheck, factcheckNdjson, passageFromMessages, type FactCheckResult } from './_lib/factcheck.js'
export { extractClaims } from './_lib/claims.js'
export { ttsStream } from './_lib/speech.js'
export { listenGrant } from './_lib/listen.js'
export { recordClientEvents } from './_lib/clientMeter.js'
export { fetchArticle, blockedHost } from './_lib/fetch.js'
export { navigate, type NavigateRequest, type NavigateDecision } from './_lib/navigate.js'
export { libraryRequest, LibraryError, type LibraryRequest, type LibraryResponse } from './_lib/library.js'
export { admit, gate, refusalHeaders, bodyChars, callerOf, resetLimits, LIMITS, type Route, type Refusal } from './_lib/guard.js'
