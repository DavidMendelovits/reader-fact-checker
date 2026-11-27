# readwithme

**readwithme** is a proof-of-concept **voice-first reader**. Open an article or EPUB and an agent starts reading it to you. Talk over it whenever you want — *"wait, is that true?"*, *"go back a bit"*, *"highlight that"*, *"skip to chapter four"* — and it answers, acts, and picks the book back up.

There is no wake word and no command syntax. The mic stays live while it narrates; whatever you say is a turn in a conversation, and the agent decides what to do about it.

Built as a Readwise Reader-inspired POC.

## What makes it work

The interesting bet is that **the agent drives playback, rather than the UI driving the agent**. Three consequences worth calling out:

- **`read_aloud` takes a range, not a paragraph.** Playback runs locally with no model in the loop, and the tool call doesn't resolve until the range finishes *or* you talk over it. A chapter of narration costs one model round-trip instead of one per paragraph. When it comes back interrupted, your interrupting sentence rides along in the same turn as the tool result — which is what lets *"wait, what was that?"* resolve against the text you just heard.
- **The simplest commands never reach the model.** "Pause", "faster", "keep going" are matched locally and run instantly — including off the *partial* transcript, because Chrome sits on a one-word utterance for a beat after you stop talking, and that's a long time to keep reading at someone who said "stop". The agent finds out from the transcript on its next turn.
- **Verdicts are spoken the moment they're ready.** A fact check streams back as JSON; the spoken one-liner closes well before the written summary and the sources do, so it's read aloud as soon as that field completes rather than after a second model turn that would only rephrase it.
- **Navigation is decided, not generated.** "Open the Hemingway one", "skip to chapter three", "archive that", "hold on", "back to the library" have one right answer among a short list, and waiting several seconds for a conversation turn to find it was the slowest thing in the app. With a `TYPESAFE_API_KEY` set, `/api/navigate` puts the transcript and the candidates (the library's titles, the chapters, the shelves) to [TypeSafe's Jev](https://typesafe.ai), a decision model that returns a label and a calibrated confidence in about a tenth of a second, and the app acts on a confident answer at once. It is asked on *partial* transcripts too, while the reader is still speaking — the recognizer waits for silence before it finalizes, and the words are clear well before then — with a higher bar for acting early. Anything unsure goes to the conversation as before, so the worst case is exactly what it was. And when the decision lands over a turn in flight — you talked over the narration — the app acts and the turn ends there, without a model reply to talk over what you just asked for. It sits behind a `Decider` port like every other vendor here.
- **Replies are spoken a sentence at a time, as they stream.** The agent's turn arrives as NDJSON and each sentence goes to the synthesizer the moment it closes, while the model is still writing the rest — including the tool call that follows. "Let me check that" used to wait behind the whole fact-check argument being generated; now it plays while that happens.

## Features

- **Import** — paste any article URL (Readability extraction) or drop an EPUB
- **Your library, hands-free** — paste a Readwise access token on the home screen, then say *"switch to the Hemingway one"*, *"start that piece about sleep from the beginning"*, *"go to chapter three"*, *"halfway through"*, *"what did I highlight about naps?"* or *"what should I read next?"*. Switching saves your place in the document you leave; one you started in Reader or on the phone picks up from there. The token stays in your browser and rides with each `/api/library` request; the server never stores it. Searching, start-at and recommending are shared with the phone (`shared/library/`)
- **Conversational playback** — the agent greets you, starts reading, and keeps going into the next section on its own; interrupt by voice at any time
- **Voice fact check** — ask about anything you just heard; it says one line so you're not sitting in silence, searches, then speaks the verdict and pins a card with sources
- **Highlights** — say *"highlight that, it's the bit for my talk"* and your comment is saved as the note; or select text in the reader for a highlight / fact-check toolbar. A highlight is one complete thought: a joke's setup and punchline land as one highlight. Ask to skip words (*"just the first and last line"*) and the kept runs are saved as one highlight, and go to Readwise tagged `.c1`, `.c2` so Readwise joins them. On a document opened from Reader, a highlight goes to Readwise in the background (retried when the document is next opened or the browser comes back online), and removing it takes it out again. Highlights from before this, and on imported articles or EPUBs, stay in this browser
- **Resume** — reopening a book restores its position, highlights, cards, and the conversation itself; after a long gap the agent recaps where things stand before continuing
- **Whole-document scan** — extracts the checkable claims section by section and verifies them in the background
- **One Composer bar** — the same bar on the phone and on the web: mic, a single status line (your words as you say them, then the agent's reply, then "Reading ¶12/340"), play/pause, a transcript sheet (under 900px; wider windows keep the conversation panel beside the reader), and a keyboard glyph; a speed pill and **Check document** sit in the header
- **Barge-in on sound** — narration stops on the first sound of your voice, off the mic level, before a word is recognized; a cough holds it for a moment and it picks back up on its own
- **Type instead of talking** — the Composer's keyboard glyph opens a text field that drives the same agent, so you can demo the whole thing with no microphone
- **The aurora** — a colour around the edges of the screen that rises with your voice, sweeps side to side while the agent thinks, and pulses in cooler tones while it reads; quiet at rest, and a still wash under reduced motion. One shader (`shared/voice/aurora.shader.ts`) runs on both platforms: WebGL on the web, fed from the app's own echo-cancelled mic meter rather than a second capture (which would cost the echo cancellation that lets you talk over the narration); Skia on the phone, driven by the recognizer's own volume reports

## Mobile

`mobile/` is a phone client for your **Readwise Reader library**, voice-first. Readwise stays the backend — capture, sync, exports — and this app is the way you read and listen on the phone.

- **Your library, by voice.** Sign in with your Reader access token (kept in the device keychain) and the inbox, later, and archive are cached on the phone and kept in sync incrementally. The mic is live from the first screen: *"what's new?"*, *"open the Hemingway one"*, *"read me that article about sleep"*. The agent searches the library, opens the document, and picks up where you left off.
- **Books and articles, read to you.** Documents split into chapters at their headings, so *"skip to chapter three"* works and chapter titles are read aloud. Position is remembered per document.
- **Highlights, in the book.** *"Highlight that, it's the bit for my talk"* — or long-press a paragraph — paints the passage in the text at once and writes it to Readwise in the background (retried until it lands). Highlights you made in Reader are pulled in and painted too. Tap one to add a note or remove it.
- **Filing by voice.** *"Archive that"*, *"save it for later"*, *"back to the library"*.
- **Fast by decision.** Opening, chapters, filing, closing, and stopping are decided by the server's decision model off the partial transcript (see "Navigation is decided" above), so a book is opening before the recognizer has finished listening; the conversation model only hears what the decision model wasn't sure about.
- **The Composer bar.** One bar on every signed-in screen: mic, a single line (your words as you say them, then the agent's reply, then "Reading ¶12/340"), play/pause while a book is open, a transcript sheet with filing, and a keyboard glyph that opens a text field that rides above the keyboard instead of hiding under it.
- **Barge-in on sound.** Narration stops on the first sound of your voice, off the mic level rather than after three recognized words; a cough holds it for a moment and it picks back up on its own. Books open at the saved spot, and a "Back to the voice" pill appears when you scroll away while it reads.
- **Paper and Ink.** A light theme and a dark one, following the system or pinned in Settings; reading is a serif. The tokens are in [DESIGN.md](DESIGN.md).
- **The rest of the reader:** fact check anything you just heard, the transport fast paths, a speed pill in the header, the same agent as the web app, and the same aurora around the edges — the recognizer reports the mic level, and the aurora rises with it, sweeps while the agent thinks, and pulses while it reads.

The architecture is the web app's, and the voice code is now literally shared: the conversation loop (`shared/voice/agent.ts`), the hold/release barge-in, recognizer restarts and echo handling live in `shared/voice/` and run on both platforms, with `src/lib/agent.ts` and `mobile/src/agent.ts` as thin adapters. The agent drives playback through `read_aloud`, transport commands run locally off partial transcripts, and each app's library tools and their guidance live in `shared/agent/clients.ts`: a request names its app (`client: 'web'` or `'phone'`) and the server adds that kit, so no request can put its own instructions in the prompt. Model keys never ship in the bundle; the app talks to this repo's deployed `/api` routes. Reader's API is behind a `Library` port (`shared/library/types.ts`); Readwise is the one adapter (`shared/library/readwise.ts`), used by the phone directly and by the web through `/api/library`.

The voice is a choice. The OS voice (`expo-speech`) works out of the box. In settings, download **Kokoro** (~90MB, once) to narrate on-device through `react-native-sherpa-onnx` — the same model the web app's Unreal Speech voice is built on, so both platforms read in one voice, and the phone does it offline for free.

```bash
cd mobile
npm install
npm run check      # tsc, then the phone's Vitest tests (data layer, layout, tts, voice, theme, settings)
npm run smoke:web  # the whole app in a headless browser, against a fake Reader and a scripted model
npx expo run:ios   # dev build — speech recognition and Kokoro are native modules, so Expo Go won't do
```

Then paste your token from [readwise.io/access_token](https://readwise.io/access_token).

`smoke:web` exports the app for the web (React Native Web; the on-device voice has a web stub and narration is silent), serves it with `smoke/fake-backend.mjs` — a four-document Reader library plus a model that answers the handful of things the test says — and drives it with Playwright the way a person would: sign in, search, open a book by typing what you'd say, let it read, highlight by long-press and by voice, note, remove, archive, close, reopen to the saved position, try a PDF, sign out. It needs a Chromium (`SMOKE_CHROME=/path/to/chrome` if Playwright's isn't installed). The same build also works under [agent-device](https://github.com/callstackincubator/agent-device)'s web target, which is how it was first driven; its accessibility snapshots are why every control here carries a role and a label.

Known gaps, in the order they'll matter: no lock-screen controls yet (background audio is enabled, remote commands need a native module); PDFs and videos have no text in Reader's API, so they're listed but say so when opened; no share-sheet capture (save to Reader from other apps as you do today); highlight *notes* live on the phone only, since Readwise's v2 API has no highlight-update call; and nothing here has run on a phone yet — it typechecks, the data layer is tested, and the whole flow runs in a browser against a fake Reader, but the native modules (the ear, the on-device voice, background audio) and the real Readwise responses meet the app for the first time on your device.

## Verifying the phone app

```bash
npm run check                    # root: shared/voice, web, api checks + tsc
cd mobile && npm run check       # tsc, then the phone's Vitest tests
cd mobile && npm run smoke:web   # the whole app in a headless browser
```

`smoke:web` needs a Chromium: Playwright's (`npx playwright install chromium`) or any Chrome via `SMOKE_CHROME=/path/to/chrome`. `SMOKE_PORT=8092` moves the app off 8082 when a dev server already has that port, and `SMOKE_BACKEND_PORT` moves the fake backend off 5300. `EXPO_PUBLIC_READWISE_BASE` points a dev build at a stand-in Reader, and `EXPO_PUBLIC_SILENT_VOICE` silences narration; in dev and silent builds, a line starting with `>` in the Composer's text field goes to the ear as if you had said it.

The ear, the aurora and the keyboard are native modules, so none of the above is the definition of done. That is:

1. `cd mobile && npm run ios` (or `npm run android`, or `eas build --profile development`) → install the dev client → cold start it.
2. Exercise the aurora, the keyboard and speech on the iOS simulator **and** on an Android emulator, API 35.

**iOS, loud speaker, no headphones**

- [ ] narration playing, say "wait" → the audio stops within 200ms
- [ ] cough once → it pauses, then resumes by itself within 1.5s of silence
- [ ] let it read for 70s (past a recognizer restart), then interrupt again → it still stops

**Android, API 35 emulator, keyboard up**

- [ ] sign-in token, library search, Composer field, note sheet, settings API URL: each one visible with its submit control while the keyboard is open
- [ ] the Composer rides the keyboard rather than hiding under it

## Setup (local)

```bash
npm install
cp .env.local.example .env.local   # then paste your keys in
npm run dev
```

`.env.local` needs these three (server-side only — never bundled into the browser):

- `ANTHROPIC_API_KEY` — the conversation agent and claim extraction (`claude-sonnet-5`)
- `PERPLEXITY_API_KEY` — fact checking (`sonar`)
- `OPENAI_API_KEY` — text-to-speech (`gpt-4o-mini-tts`)

Optionally, `TYPESAFE_API_KEY` turns on the decision model for navigation (see "Navigation is decided" above); without it every command goes through the conversation. And optionally, `UNREAL_SPEECH_API_KEY` switches text-to-speech to [Unreal Speech](https://unrealspeech.com) — hosted Kokoro, about a third the price per hour of narration and ~300ms to first audio against ~1.2s. Their streaming endpoint takes 1,000 characters a call, so the server splits paragraphs at sentence boundaries and pipes the pieces back as one MP3; the client never knows. `TTS_PROVIDER=openai` forces OpenAI even with the key set; `UNREAL_SPEECH_VOICE` picks the voice. With `ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID` both set, speech goes to [ElevenLabs](https://elevenlabs.io) on Eleven v4 Turbo (~100ms to first audio by their figures) ahead of either. With `DEEPGRAM_API_KEY` set, the web app's speech input moves from Chrome's recognizer to [Deepgram Flux](https://developers.deepgram.com/docs/flux/quickstart): the page streams the mic straight to Flux on a short-lived token from `/api/listen`, so the key stays on the server, and Flux decides when you've finished a turn from your words and the pause together. It also works outside Chrome. Without the key the app keeps Chrome's recognizer.

Restart `npm run dev` after editing `.env.local`.

### Tests

```bash
npm run check   # typecheck, then every test once
npm test        # watch mode
```

Tests run on [Vitest](https://vitest.dev). Every vendor is mocked at its port (`api/_lib/ports.ts`, swapped with `override()` in `api/_lib/providers.ts`) or with `vi.fn`, so the suite needs no keys and runs in a few seconds. A setup file (`test/no-network.ts`) fails any socket that leaves the machine, so a test that forgets a mock fails instead of calling a vendor. The phone app's tests run the same way from `mobile/` (`npm run check`, `npm test`), with native modules swapped for the small stubs in `mobile/test/stubs` and the same no-network guard.

### Replay runs

```bash
AGENT_PROVIDER=fake TTS_PROVIDER=fake npm run replay   # free dry run of the harness
REPLAY_LIVE=1 REPLAY_LABEL="sonnet-5 + elevenlabs" npm run replay
```

A replay run sends 50 typed voice commands (`test/replay/commands.json`) through the agent, against a short fixed story (`test/replay/book.ts`), and the first chapter through the voice. It scores whether each command got the right tool with the right arguments, and adds one row to `test/replay/out/results.csv` (a run with any fake port goes to `dry-run.csv` instead): tool and argument accuracy, time to the reply's first words and to the first audio, characters spoken and the agent's cost. Every miss is printed. It uses whatever vendors env picks, keys from `.env.local` included, so compare combinations by changing `AGENT_MODEL` or `TTS_PROVIDER` between runs, and rerun it when a vendor ships a new model. A live run spends real money (50 agent turns and five paragraphs of speech), so it refuses to start without `REPLAY_LIVE=1`. `REPLAY_LIMIT=10` runs the first ten commands. The commands are typed, not spoken, so the ear and barge-in aren't measured yet.

### End-to-end test environment

```bash
npm run dev:e2e
```

Runs the app with every server port on a fake (`api/_lib/adapters/fake.ts`, chosen by `.env.e2e`): a rule-based agent, a fact check that answers after 4 seconds (`FAKE_SEARCH_MS`), and a silent voice that takes as long as the text would to say. It exists for browser and device tests, not as a product mode. Providers are always picked by environment variables on the server, never by a user setting, so a single port can be faked too, for example `FACTCHECK_PROVIDER=fake npm run dev`.

Fact checks run on Perplexity rather than an agentic search-then-read loop because search *is* the product there — retrieval happens inside one inference pass, which is most of why a verdict lands in seconds instead of tens of seconds.

## Demo script

Best in **Chrome** (speech recognition is Chrome-only unless the deployment sets `DEEPGRAM_API_KEY`) with **headphones**, so the mic doesn't hear the narration. Every step below also works by typing, if you'd rather skip the audio setup.

1. Paste `https://en.wikipedia.org/wiki/Moon_landing` — it starts reading on its own
2. Tap the mic in the Composer bar and allow it
3. Talk over the narration: *"wait, is that right?"* → it says a holding line, searches, speaks the verdict, and pins a card with sources
4. *"highlight that, it contradicts what he said earlier"* → saved with your comment as the note
5. *"skip ahead to the Apollo program"* → it locates the passage by content and reads from there
6. Say *"pause"* mid-sentence — it stops immediately, before the model is involved
7. Reload the page and reopen the book from **Continue reading** — same position, same highlights, same conversation
8. **Check document** in the header runs a background scan while you keep listening
9. There's a Project Gutenberg EPUB at `public/test.epub` for the book-import path

## POC limits (deliberate)

- Speech input is the browser's `webkitSpeechRecognition` — **Chrome only**. The mic stays live during narration so you can talk over it, and a word-overlap heuristic drops the recognizer's transcription of the narration itself; headphones make that reliable
- **Access control is one shared code.** Set `APP_TOKEN` on the server and every `/api/*` route asks for it (the web asks once and keeps it in the browser; the phone has an Access code field in Settings). Without it the routes are open, so a deployed URL lets anyone spend your API credits: set spend limits on every key either way. Each route also caps how often one address may call it and how large a request may be (`api/_lib/guard.ts`), but those counts live in each function instance's memory, so they slow abuse rather than stop it
- `/api/fetch` fetches any public page for article import (needed to dodge CORS). It answers in JSON, never as HTML from this origin, refuses private and loopback hosts (IPv4 and IPv6, every redirect hop), and doesn't pin DNS, so a name that resolves to a private address still gets through
- Library and position live in `localStorage` — per-browser, no account, no sync
- No PDF import yet (pdf.js would slot into `src/lib/extract.ts`)
- iOS suspends a locked page's JS, so narration stops with the screen; a wake lock covers read-along but true lock-screen playback needs a native wrapper

## Deploy (Vercel)

`api/` holds the serverless functions (`/api/agent-stream`, `/api/agent`, `/api/navigate`, `/api/factcheck`, `/api/claims`, `/api/tts`, `/api/fetch`); `vite.config.ts` mirrors the same routes in dev, so dev and prod behave identically. All keys stay server-side. The web app uses the streaming agent route; `/api/agent` is the buffered version the mobile app still uses, since React Native's fetch can't read a body incrementally.

```bash
npx vercel                          # link + first deploy
npx vercel env add ANTHROPIC_API_KEY
npx vercel env add PERPLEXITY_API_KEY
npx vercel env add OPENAI_API_KEY
npx vercel env add TYPESAFE_API_KEY        # optional, see Setup
npx vercel env add UNREAL_SPEECH_API_KEY   # optional, see Setup
npx vercel env add ELEVENLABS_API_KEY      # optional; needs the voice id too
npx vercel env add ELEVENLABS_VOICE_ID
npx vercel env add DEEPGRAM_API_KEY        # optional; streaming speech input on the web
npx vercel env add APP_TOKEN               # recommended: the access code every /api route asks for
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
api/_lib/meter.ts          wraps every port: time, first text, billed units and
                           cost per call, one `[meter] {...}` log line each
api/_lib/clientMeter.ts    /api/meter: the browser's own timings, checked and
                           logged as `[meter]` lines with `client: "web"`
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
src/lib/agent.ts           the browser's half of the agent: what a player, a store, a
                           transport and a tool are here, for the shared loop
src/lib/controller.ts      wiring for everything the conversation doesn't own: manual
                           transport, mic lifecycle, highlight + whole-document jobs
src/lib/persist.ts         localStorage library: position, cards, highlights, transcript
src/lib/readwiseHighlights.ts  highlights on a Reader document to Readwise: pending, retried, removable
src/lib/extract.ts         URL/EPUB → { title, chapters: [{ title, paragraphs }] }
src/store.ts               zustand: doc, position, agent state, jobs, highlights, chat
src/components/            ImportScreen, Header, Reader, Composer, TranscriptSheet,
                           Aurora, Notice, ChatPanel, FactCheckPanel

shared/voice/agent.ts      the conversation loop, once, for both apps: the turn loop,
                           fast-path commands, decide-then-loop, interruption handling
shared/voice/holdGate.ts   barge-in policy without a player: hold on sound, release on
                           a false start, or convert into the real interruption
shared/voice/bargeIn.ts    when to hold, decided from mic level alone
shared/voice/restartPolicy.ts  who may start the recognizer, and when (a generation token)
shared/voice/echo.ts       the echo filter: drops the recognizer's transcription of the
                           narration itself
shared/voice/line.ts       the Composer's one line of text: one priority, one string
shared/voice/aurora.shader.ts  the aurora shader, run by Skia on the phone and WebGL on
                           the web

mobile/src/agent.ts        the phone's half of the agent (library tools, navigation kinds)
mobile/src/voice.ts        Transcriber on expo-speech-recognition + level-based barge-in
mobile/src/theme.ts        Paper / Ink tokens (see DESIGN.md)
mobile/src/ui/             Composer, ReaderList, LibraryScreen, ReaderScreen, SettingsScreen,
                           SignInScreen, TranscriptSheet, SpeedSheet, NoteSheet,
                           BackToVoicePill, Toast
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
| `DECIDER_PROVIDER` | decider | `typesafe` if `TYPESAFE_API_KEY` is set, else `none` |
| `TTS_PROVIDER` | speech | `elevenlabs` if `ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID` are set, else `unreal` if `UNREAL_SPEECH_API_KEY` is, else `openai` |
| `LIBRARY_PROVIDER` | library | `readwise`, with the caller's own token |
| `LISTEN_PROVIDER` | listen | `deepgram` if `DEEPGRAM_API_KEY` is set, else `none` (Chrome's recognizer) |

To add a text-to-speech vendor, say: write `api/_lib/adapters/<vendor>.ts` returning a
`SpeechSynthesizer` (one request in, a streaming MP3 out, `maxChars` if the vendor caps
the text), add it to the `speech` registry in `providers.ts`, and set `TTS_PROVIDER`.
The stitching, the routes, and both clients stay as they are, and the new vendor is
metered like the others.

To compare vendors, read the `[meter]` lines in the function logs: each call's port,
provider, model, `ms`, `firstMs` (time to first text), units (tokens, or characters of
speech) and `cost` in dollars where `PRICES` in `meter.ts` knows the model. Tokens
and cost come from conversation turns only for now; claims and fact checks log time.
For speech, `ok` means the audio started, not that the stream finished.

The web app adds three lines of its own, sent to `/api/meter` about every half
minute and when the tab closes, each marked `client: "web"`:

- `bargein`: `ms` from the first loud mic report to the narration stopping, with
  `provider` `level` (the mic level fired) or `words` (the transcript did), and `ok`
  false for a false start (a cough, a door).
- `first_audio`: `ms` from a turn going to the model to the first sound back,
  `provider` `reply` or `narration`.
- `listen_audio`: `units.seconds` of audio sent to Deepgram, which is what Flux
  bills, reported each minute of audio and when a stream ends, with `ms` the span
  it covers. (The server's own `listen` line times the token grant.)

One caveat on the conversation port: the transcript is persisted in the app's block
vocabulary (`text`, `tool_use`, `tool_result`) plus any vendor-specific blocks the
current model needs echoed back (Anthropic's thinking blocks). A different vendor's
adapter must drop blocks it doesn't own; a conversation that started on one vendor
continues on another, minus those.

Two ideas hold it together:

**The flat paragraph index is the universal position unit.** It drives playback, the reading highlight, the text the agent is shown around your position, highlight anchors, and job anchors — click any verdict card to jump to the passage it came from.

**The tool-use transcript is the real conversation.** The chat bubbles are a lossy view of it, so persistence round-trips the transcript rather than the bubbles; reopening a book resumes the actual conversation, including what the agent was in the middle of doing.

Design tokens, type, spacing and motion are in [DESIGN.md](DESIGN.md); deferred work is in [TODOS.md](TODOS.md); releases are in [CHANGELOG.md](CHANGELOG.md).
