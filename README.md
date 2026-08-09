# Reader Fact Checker

A proof-of-concept audio reader with **voice-activated fact checking**. Listen to any web article or EPUB; at any point say **"fact check"** and an agent grabs the last two paragraphs you heard, searches the web (Claude + web search), and speaks a verdict back — then listens for follow-up questions before resuming the book.

Built as a Readwise Reader-inspired POC.

## Features

- **Import**: paste any article URL (Readability extraction) or drop an EPUB
- **Listen**: OpenAI TTS reads paragraph-by-paragraph with live highlight + auto-scroll (double-click any paragraph to play from there)
- **Voice fact check**: enable the wake word, say *"fact check"* (or *"fact check the claim about X"*) — reading pauses, Claude searches the web, the verdict is spoken aloud and pinned in the panel with sources; keep asking follow-ups by voice
- **Highlight fact check**: select any text → "Fact check this" — runs async while you keep reading
- **Whole-document scan**: extracts the significant checkable claims per section and fact-checks them all in the background with a progress indicator

## Setup (local)

```bash
npm install
cp .env.local.example .env.local   # then paste your keys in
npm run dev
```

`.env.local` needs (server-side only — never bundled into the browser):

- `ANTHROPIC_API_KEY` — fact checking (`claude-opus-5` + the `web_search` server tool)
- `OPENAI_API_KEY` — text-to-speech (`gpt-4o-mini-tts`)

Restart `npm run dev` after editing `.env.local`.

## Deploy (Vercel)

The `api/` directory contains Vercel serverless functions (`/api/factcheck`, `/api/claims`, `/api/tts`, `/api/fetch`); the Vite dev server mirrors the same routes locally via `vite.config.ts`, so dev and prod behave identically. All keys stay server-side.

```bash
npx vercel                # link + first deploy
npx vercel env add ANTHROPIC_API_KEY
npx vercel env add OPENAI_API_KEY
npx vercel --prod
```

**Share the clean alias** — `https://<project>.vercel.app` — not the hashed URL the CLI prints after deploying (`<project>-<hash>-<team>.vercel.app`). Under Vercel's default Deployment Protection the hashed and team-scoped URLs require a Vercel login *and* team membership, so outside collaborators get bounced; only the clean production alias is public.

Note: fact-check calls run 20–60s (web search); the functions declare `maxDuration` accordingly, which needs Vercel's fluid compute (on by default for new projects). Set spend limits on both API keys before sharing the link.

## Demo script

1. Open in **Chrome** (speech recognition is Chrome-only) with **headphones** (so the mic doesn't hear the TTS)
2. Paste `https://en.wikipedia.org/wiki/Moon_landing` → Play
3. Click **🎙 Enable wake word**, allow the mic
4. While it reads, say **"fact check"** → it pauses, searches, speaks the verdict → ask a follow-up out loud, or stay silent to resume
5. Highlight a sentence → **Fact check this**
6. Click **Fact check whole document** and keep listening while verdicts stream into the panel
7. There's a Project Gutenberg EPUB at `public/test.epub` to demo book import (drag it into the drop zone)

The **⚡ simulate wake** button triggers the voice pipeline without a microphone (useful for testing).

## POC limits (deliberate)

- Speech input is the browser's `webkitSpeechRecognition` — Chrome only. The mic stays live during narration so you can talk over it, and a word-overlap heuristic drops the recognizer's transcription of the narration itself; headphones make that reliable
- **No access control.** Every `/api/*` route is open, so a deployed URL lets anyone spend your Anthropic and OpenAI credits
- `/api/fetch` is an open HTML proxy (needed to dodge CORS on article import)
- No PDF import yet (pdf.js would slot into `src/lib/extract.ts`)

## Architecture

```
api/_impl.ts           server-side core: Claude fact-check/claims, OpenAI TTS, article
                       fetch, access-code check (used by both Vercel + Vite dev)
api/*.ts               Vercel serverless functions wrapping _impl
vite.config.ts         dev-server middleware mirroring the same /api routes
src/lib/api.ts         fetch wrapper: access-code prompt + retry on 401
src/lib/extract.ts     URL/EPUB → { title, chapters: [{ title, paragraphs }] }
src/lib/tts.ts         TTS queue: per-paragraph synth + prefetch, verdict speech
src/lib/voice.ts       continuous SpeechRecognition: wake-word detect + follow-up capture
src/lib/factcheck.ts   client for /api/factcheck, /api/claims (conversation round-trips)
src/lib/controller.ts  orchestration: playback, wake flow, highlight + whole-doc jobs
src/store.ts           zustand: doc, playback position, voice state, async job list
src/components/        ImportScreen, Reader, PlayerBar, FactCheckPanel, VoiceOverlay
```

The **flat paragraph index** is the universal position unit: it drives TTS playback, the reading highlight, the "last two paragraphs" fact-check context, and job anchors (click a verdict card to jump to its passage).
