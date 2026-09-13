# Reader Fact Checker

A proof-of-concept **voice-first reader**. Open an article or EPUB and an agent starts reading it to you. Talk over it whenever you want — *"wait, is that true?"*, *"go back a bit"*, *"highlight that"*, *"skip to chapter four"* — and it answers, acts, and picks the book back up.

There is no wake word and no command syntax. The mic stays live while it narrates; whatever you say is a turn in a conversation, and the agent decides what to do about it.

Built as a Readwise Reader-inspired POC.

## What makes it work

The interesting bet is that **the agent drives playback, rather than the UI driving the agent**. Three consequences worth calling out:

- **`read_aloud` takes a range, not a paragraph.** Playback runs locally with no model in the loop, and the tool call doesn't resolve until the range finishes *or* you talk over it. A chapter of narration costs one model round-trip instead of one per paragraph. When it comes back interrupted, your interrupting sentence rides along in the same turn as the tool result — which is what lets *"wait, what was that?"* resolve against the text you just heard.
- **The simplest commands never reach the model.** "Pause", "faster", "keep going" are matched locally and run instantly — including off the *partial* transcript, because Chrome sits on a one-word utterance for a beat after you stop talking, and that's a long time to keep reading at someone who said "stop". The agent finds out from the transcript on its next turn.
- **Verdicts are spoken the moment they're ready.** A fact check streams back as JSON; the spoken one-liner closes well before the written summary and the sources do, so it's read aloud as soon as that field completes rather than after a second model turn that would only rephrase it.
- **Replies are spoken a sentence at a time, as they stream.** The agent's turn arrives as NDJSON and each sentence goes to the synthesizer the moment it closes, while the model is still writing the rest — including the tool call that follows. "Let me check that" used to wait behind the whole fact-check argument being generated; now it plays while that happens.

## Features

- **Import** — paste any article URL (Readability extraction) or drop an EPUB
- **Conversational playback** — the agent greets you, starts reading, and keeps going into the next section on its own; interrupt by voice at any time
- **Voice fact check** — ask about anything you just heard; it says one line so you're not sitting in silence, searches, then speaks the verdict and pins a card with sources
- **Highlights** — say *"highlight that, it's the bit for my talk"* and your comment is saved as the note; or select text in the reader for a highlight / fact-check toolbar
- **Resume** — reopening a book restores its position, highlights, cards, and the conversation itself; after a long gap the agent recaps where things stand before continuing
- **Whole-document scan** — extracts the checkable claims section by section and verifies them in the background
- **Type instead of talking** — a text box drives the same agent, so you can demo the whole thing with no microphone

## Mobile

`mobile/` is a phone client for your **Readwise Reader library**, voice-first. Readwise stays the backend — capture, sync, exports — and this app is the way you read and listen on the phone.

- **Your library, by voice.** Sign in with your Reader access token and the inbox, later, and archive are cached on the phone and kept in sync incrementally. The mic is live from the first screen: *"what's new?"*, *"open the Hemingway one"*, *"read me that article about sleep"*. The agent searches the library, opens the document, and picks up where you left off.
- **Books and articles, read to you.** Documents split into chapters at their headings, so *"skip to chapter three"* works and chapter titles are read aloud. Position is remembered per document.
- **Highlights, in the book.** *"Highlight that, it's the bit for my talk"* — or long-press a paragraph — paints the passage in the text at once and writes it to Readwise in the background (retried until it lands). Highlights you made in Reader are pulled in and painted too. Tap one to add a note or remove it.
- **Filing by voice.** *"Archive that"*, *"save it for later"*, *"back to the library"*.
- **The rest of the reader:** fact check anything you just heard, the transport fast paths, the same agent as the web app.

The architecture is the web app's, ported: the agent drives playback through `read_aloud`, transport commands run locally off partial transcripts, and now the phone declares its own library tools to the shared agent (`clientTools` on the agent request), so the server prompt stays one thing. Model keys never ship in the bundle; the app talks to this repo's deployed `/api` routes. Reader's API is behind a `Library` port (`src/ports.ts`); Readwise is the one adapter (`src/readwise.ts`).

The voice is a choice. The OS voice (`expo-speech`) works out of the box. In settings, download **Kokoro** (~90MB, once) to narrate on-device through `react-native-sherpa-onnx` — the same model the web app's Unreal Speech voice is built on, so both platforms read in one voice, and the phone does it offline for free.

```bash
cd mobile
npm install
npm run check      # the data layer against a fake Reader API, under node
npx expo run:ios   # dev build — speech recognition and Kokoro are native modules, so Expo Go won't do
```

Then paste your token from [readwise.io/access_token](https://readwise.io/access_token).

Known gaps, in the order they'll matter: no lock-screen controls yet (background audio is enabled, remote commands need a native module); PDFs and videos have no text in Reader's API, so they're listed but say so when opened; no share-sheet capture (save to Reader from other apps as you do today); highlight *notes* live on the phone only, since Readwise's v2 API has no highlight-update call; nothing here has run on a device yet — it typechecks and the data layer is tested, and the first real session will find what a fake Reader can't.

## Setup (local)

```bash
npm install
cp .env.local.example .env.local   # then paste your keys in
npm run dev
```

`.env.local` needs all three (server-side only — never bundled into the browser):

- `ANTHROPIC_API_KEY` — the conversation agent and claim extraction (`claude-sonnet-5`)
- `PERPLEXITY_API_KEY` — fact checking (`sonar`)
- `OPENAI_API_KEY` — text-to-speech (`gpt-4o-mini-tts`)

Optionally, `UNREAL_SPEECH_API_KEY` switches text-to-speech to [Unreal Speech](https://unrealspeech.com) — hosted Kokoro, about a third the price per hour of narration and ~300ms to first audio against ~1.2s. Their streaming endpoint takes 1,000 characters a call, so the server splits paragraphs at sentence boundaries and pipes the pieces back as one MP3; the client never knows. `TTS_PROVIDER=openai` forces OpenAI even with the key set; `UNREAL_SPEECH_VOICE` picks the voice.

Restart `npm run dev` after editing `.env.local`.

Fact checks run on Perplexity rather than an agentic search-then-read loop because search *is* the product there — retrieval happens inside one inference pass, which is most of why a verdict lands in seconds instead of tens of seconds.

## Demo script

Best in **Chrome** (speech recognition is Chrome-only) with **headphones**, so the mic doesn't hear the narration. Every step below also works by typing, if you'd rather skip the audio setup.

1. Paste `https://en.wikipedia.org/wiki/Moon_landing` — it starts reading on its own
2. Click **🎙 Enable mic** and allow it
3. Talk over the narration: *"wait, is that right?"* → it says a holding line, searches, speaks the verdict, and pins a card with sources
4. *"highlight that, it contradicts what he said earlier"* → saved with your comment as the note
5. *"skip ahead to the Apollo program"* → it locates the passage by content and reads from there
6. Say *"pause"* mid-sentence — it stops immediately, before the model is involved
7. Reload the page and reopen the book from **Continue reading** — same position, same highlights, same conversation
8. **Fact check whole document** runs a background scan while you keep listening
9. There's a Project Gutenberg EPUB at `public/test.epub` for the book-import path

## POC limits (deliberate)

- Speech input is the browser's `webkitSpeechRecognition` — **Chrome only**. The mic stays live during narration so you can talk over it, and a word-overlap heuristic drops the recognizer's transcription of the narration itself; headphones make that reliable
- **No access control.** Every `/api/*` route is open, so a deployed URL lets anyone spend your API credits. Set spend limits on all three keys before sharing a link
- `/api/fetch` is an open HTML proxy (needed to dodge CORS on article import)
- Library and position live in `localStorage` — per-browser, no account, no sync
- No PDF import yet (pdf.js would slot into `src/lib/extract.ts`)
- iOS suspends a locked page's JS, so narration stops with the screen; a wake lock covers read-along but true lock-screen playback needs a native wrapper

## Deploy (Vercel)

`api/` holds the serverless functions (`/api/agent-stream`, `/api/agent`, `/api/factcheck`, `/api/claims`, `/api/tts`, `/api/fetch`); `vite.config.ts` mirrors the same routes in dev, so dev and prod behave identically. All keys stay server-side. The web app uses the streaming agent route; `/api/agent` is the buffered version the mobile app still uses, since React Native's fetch can't read a body incrementally.

```bash
npx vercel                          # link + first deploy
npx vercel env add ANTHROPIC_API_KEY
npx vercel env add PERPLEXITY_API_KEY
npx vercel env add OPENAI_API_KEY
npx vercel env add UNREAL_SPEECH_API_KEY   # optional, see Setup
npx vercel --prod
```

**Share the clean alias** — `https://<project>.vercel.app` — not the hashed URL the CLI prints (`<project>-<hash>-<team>.vercel.app`). Under Vercel's default Deployment Protection the hashed and team-scoped URLs need a Vercel login *and* team membership, so outside collaborators get bounced; only the clean production alias is public.

Fact-check calls can run 20–60s, so the functions declare `maxDuration` accordingly — that needs Vercel's fluid compute (on by default for new projects).

## Architecture

Ports and adapters. The application code names what it needs — a conversation
model, a search-grounded model, a JSON model, a speech synthesizer, an ear, a
voice — as interfaces, and one file per vendor implements them. A single
composition root per runtime decides which implementation runs, from env. Nothing
outside the adapters imports a vendor SDK, so changing providers is a new adapter
file plus one registry line.

```
api/_lib/ports.ts          the server's ports: ConversationModel, SearchModel,
                           JsonCompletion, SpeechSynthesizer — no vendor types
api/_lib/adapters/         one file per vendor: anthropic (conversation + JSON),
                           perplexity (search), openai-speech, unreal-speech
api/_lib/providers.ts      composition root: env → adapter, memoized; override()
                           for tests
api/_lib/agent.ts          the companion's prompt, tools, and turn use-case
api/_lib/factcheck.ts      verdict prompt, schema, parsing
api/_lib/claims.ts         claim extraction for the whole-document scan
api/_lib/speech.ts         /api/tts use-case + stitching (splits text to fit a
                           vendor's per-request cap; one continuous MP3 out)
api/_impl.ts               re-exports the use-cases for the routes
api/*.ts                   Vercel serverless functions (the only entry points)
vite.config.ts             dev-server middleware mirroring the same /api routes

src/lib/ports.ts           the browser's ports: Transcriber (the ear), AudioSource
src/lib/providers.ts       composition root: the ear and the player singletons
src/lib/voice.ts           Transcriber on Chrome's SpeechRecognition + echo rejection
src/lib/tts.ts             the player: per-paragraph synth with prefetch, sentence
                           stream for replies; serverSpeech is the default AudioSource
src/lib/sentences.ts       streaming sentence splitter (what decides when a reply starts)
src/lib/agent.ts           the conversation: tool dispatch, the turn loop, fast-path
                           commands, interruption handling — the heart of the app
src/lib/controller.ts      wiring for everything the conversation doesn't own: manual
                           transport, mic lifecycle, highlight + whole-document jobs
src/lib/persist.ts         localStorage library: position, cards, highlights, transcript
src/lib/extract.ts         URL/EPUB → { title, chapters: [{ title, paragraphs }] }
src/store.ts               zustand: doc, position, agent state, jobs, highlights, chat
src/components/            ImportScreen, Reader, PlayerBar, ChatPanel, FactCheckPanel

mobile/src/ports.ts        VoiceEngine, Transcriber
mobile/src/providers.ts    composition root: the ear, the player, and which voice
                           engine it runs on (system or on-device Kokoro)
mobile/src/tts.ts          the player + SystemVoice (expo-speech)
mobile/src/kokoro.ts       KokoroVoice on react-native-sherpa-onnx
```

Provider selection on the server:

| env | port | default |
|---|---|---|
| `AGENT_PROVIDER` | conversation | `anthropic` |
| `CLAIMS_PROVIDER` | json | `anthropic` |
| `FACTCHECK_PROVIDER` | search | `perplexity` |
| `TTS_PROVIDER` | speech | `unreal` if `UNREAL_SPEECH_API_KEY` is set, else `openai` |

To add a text-to-speech vendor, say: write `api/_lib/adapters/<vendor>.ts` returning a
`SpeechSynthesizer` (one request in, a streaming MP3 out, `maxChars` if the vendor caps
the text), add it to the `speech` registry in `providers.ts`, and set `TTS_PROVIDER`.
The stitching, the routes, and both clients stay as they are.

One caveat on the conversation port: the transcript is persisted in the app's block
vocabulary (`text`, `tool_use`, `tool_result`) plus any vendor-specific blocks the
current model needs echoed back (Anthropic's thinking blocks). A different vendor's
adapter must drop blocks it doesn't own; a conversation that started on one vendor
continues on another, minus those.

Two ideas hold it together:

**The flat paragraph index is the universal position unit.** It drives playback, the reading highlight, the text the agent is shown around your position, highlight anchors, and job anchors — click any verdict card to jump to the passage it came from.

**The tool-use transcript is the real conversation.** The chat bubbles are a lossy view of it, so persistence round-trips the transcript rather than the bubbles; reopening a book resumes the actual conversation, including what the agent was in the middle of doing.
