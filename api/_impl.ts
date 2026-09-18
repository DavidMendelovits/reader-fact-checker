// Server-side entry point shared by the Vercel functions and the Vite dev
// middleware. The code lives in _lib/: ports.ts says what the app needs,
// adapters/ implement it per vendor, providers.ts picks which one runs, and the
// use-case modules (agent, factcheck, claims, speech, fetch) sit in between.
// Keys come from process.env — never shipped to the browser.
export { agentTurn, agentNdjson, type AgentContext, type ClientExtras } from './_lib/agent.js'
export { factcheck, factcheckNdjson, passageFromMessages, type FactCheckResult } from './_lib/factcheck.js'
export { extractClaims } from './_lib/claims.js'
export { ttsStream } from './_lib/speech.js'
export { fetchArticle } from './_lib/fetch.js'
export { navigate, type NavigateRequest, type NavigateDecision } from './_lib/navigate.js'
