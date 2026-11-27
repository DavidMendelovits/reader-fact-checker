// What each client adds to the shared agent: the library tools it runs on the
// device, and the guidance for them. The server picks the kit by the client's
// name, so no request can add its own instructions or tools to the prompt.
// Each client keeps its own handlers for these tools; clients.test.ts checks
// that every tool offered here has one.
//
// Data only, no imports: the server function loads this file on its own.

export interface ToolSpec {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export type ClientId = 'web' | 'phone'

// ---- the web (src/lib/libraryTools.ts) ----

const WEB_TOOLS: ToolSpec[] = [
  {
    name: 'search_library',
    description:
      'Find documents in the reader\'s library (their Readwise library and anything saved in this browser) by ' +
      'title, author or topic: "the Hemingway one", "that piece about sleep". Pass the words the reader used. ' +
      'Returns `[id] Title by Author (length, progress, shelf): summary`, best first. Never read ids aloud.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Title, author or topic words.' } },
      required: ['query'],
    },
  },
  {
    name: 'search_highlights',
    description:
      'Search the reader\'s highlights across every document by words in the passage or their note: "what did I ' +
      'highlight about naps", "find that line about the sea". Returns each passage with the document it is from.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Words from the passage or the note.' } },
      required: ['query'],
    },
  },
  {
    name: 'open_document',
    description:
      'Switch to another document by id from search_library or recommend. Picks up where the reader left off, ' +
      'unless they asked for the beginning, a percentage ("halfway", "the last quarter") or a chapter ("chapter ' +
      'three", "the part about the storm"). Also moves within the open document when given its id. It puts the ' +
      'reader at the starting paragraph, so call read_aloud right after it with no `from`.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The id from search_library or recommend.' },
        from: { type: 'string', enum: ['resume', 'beginning'], description: 'Where the reader left off (default), or the top.' },
        percent: { type: 'number', description: '0 to 100: how far in to start. "Halfway" is 50.' },
        chapter: { type: 'string', description: 'A chapter by number or by words from its title, as the reader said it.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'recommend',
    description:
      'Suggest what to read next: unfinished documents first, then the reader\'s saved-for-later shelf, then the ' +
      'inbox. Pass `minutes` when the reader says how long they have. Returns candidates in order with length, ' +
      'progress and a summary.',
    inputSchema: {
      type: 'object',
      properties: { minutes: { type: 'number', description: 'How long the reader has, if they said.' } },
    },
  },
]

const WEB_SYSTEM = `The library:
- The reader can switch documents by voice: "switch to the Hemingway one", "start that article about sleep", "go to chapter three of the storm book". Find it with search_library, then open_document, then read_aloud with no \`from\`: open_document has already put the reader where reading should start.
- If one document clearly matches, open it. If several do, say the top two or three titles in one breath and ask which.
- "From the beginning", "halfway", "the last chapter" are open_document's from, percent and chapter. With none of them, reading picks up where the reader left off.
- "What should I read next?" is recommend: offer one pick in a sentence, with why (unfinished, short enough, on their later shelf), and open it if they agree.
- "What did I highlight about X?" is search_highlights. Read the passage, not a summary of it.
- Never read ids aloud. Titles and authors only. If the library is not available, say so in a few words and offer what is saved in this browser.`

// ---- the phone (mobile/src/agent.ts) ----

const locationSchema = {
  type: 'string',
  enum: ['new', 'later', 'archive'],
  description: 'Which shelf: "new" is the inbox, "later" is saved for later, "archive" is done with.',
}

const PHONE_TOOLS: ToolSpec[] = [
  {
    name: 'list_library',
    description:
      'List the documents on one shelf of the library, newest first, as `[id] Title — Author (category, ' +
      'length, progress)`. Defaults to the shelf the reader is looking at. Use it for "what\'s new", ' +
      '"what have I saved for later", "what\'s in my inbox". Never read the ids aloud.',
    inputSchema: { type: 'object', properties: { location: locationSchema } },
  },
  {
    name: 'search_library',
    description:
      'Find documents in the library by title, author, or topic — "the Hemingway one", "that piece ' +
      'about sleep". Spoken queries are loose; pass the words the reader used. Returns the best ' +
      'matches in the same `[id] Title — Author (...)` shape. Never read the ids aloud.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Title, author, or topic words.' } },
      required: ['query'],
    },
  },
  {
    name: 'open_document',
    description:
      'Open a document from the library by id and pick up where the reader left off. Closes whatever ' +
      'was open. The result gives the position; call read_aloud in the same turn to start reading ' +
      'from there. Fails with a spoken-ready reason when the document has no readable text.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The id from list_library or search_library.' } },
      required: ['id'],
    },
  },
  {
    name: 'close_document',
    description:
      'Put the open document away and show the library — "go back to the library", "close this", ' +
      '"I\'m done with this one". The position is remembered.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'move_document',
    description:
      'File a document on another shelf — "archive that", "save it for later", "put it back in the ' +
      'inbox". Omit `id` to mean the open document.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Document id. Defaults to the open document.' },
        location: locationSchema,
      },
      required: ['location'],
    },
  },
  {
    name: 'list_highlights',
    description:
      'List the highlights in the open document — "what have I highlighted", "read me my notes". ' +
      'Returns `[id] "text" (paragraph N) — note`. Never read the ids aloud.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'remove_highlight',
    description: 'Delete one highlight by id, here and in Readwise — "remove that highlight", "undo that".',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The id from list_highlights.' } },
      required: ['id'],
    },
  },
]

const PHONE_SYSTEM = `The library:
- When no document is open, the reader is browsing their library by voice. Find what they ask for with search_library (or list_library for "what's new", "what have I saved"), then open it with open_document; reading picks up where they left off, so call read_aloud right after.
- If several documents match, say the top two or three titles in one breath and ask which. If one clearly matches, just open it.
- Never read ids aloud. Titles and authors only.
- "Archive that", "save it for later", "put it back in the inbox" are move_document. "Go back to the library", "close this", "I'm done" are close_document.
- When a document has no readable text — a PDF, a video — say so in a few words and offer the next match.
- Highlights are painted in the book and synced to Readwise; a short confirmation is enough. "What have I highlighted" is list_highlights.`

export const CLIENT_KITS: Record<ClientId, { tools: ToolSpec[]; system: string }> = {
  web: { tools: WEB_TOOLS, system: WEB_SYSTEM },
  phone: { tools: PHONE_TOOLS, system: PHONE_SYSTEM },
}

/** The kit for a client name off the wire; anything else gets none. */
export const clientKit = (id: unknown) => (id === 'web' || id === 'phone' ? CLIENT_KITS[id] : null)
