// A stand-in for everything the phone talks to, so the app can run end to end
// in a browser with no keys and no Readwise account:
//   /api/v3/*, /api/v2/*   a small Reader library (Reader API v3 + Readwise v2)
//   /api/agent             a scripted "model": answers the way the real one would
//                          for the handful of things the smoke test says
//   /api/factcheck         a canned verdict
// Everything it receives is logged to stdout as JSON lines, so the test can
// assert what the app actually sent.
import http from 'node:http'

const PORT = Number(process.env.PORT || 5300)
const log = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`)

// ---- library ----
const chapters = (title, n, pref) =>
  Array.from({ length: n }, (_, c) =>
    `<h2>Chapter ${c + 1}: ${['The Harbour', 'The Boat', 'The Fish', 'The Return'][c] ?? 'More'}</h2>` +
    Array.from({ length: 4 }, (_, p) => `<p>${pref} paragraph ${c + 1}.${p + 1}. He was an old man who fished alone in a skiff in the Gulf Stream and he had gone ${c * 4 + p} days now without taking a fish.</p>`).join(''),
  ).join('')

const docs = [
  {
    id: 'doc-sea', title: 'The Old Man and the Sea', author: 'Ernest Hemingway', category: 'epub', location: 'later',
    source_url: 'https://example.com/old-man', word_count: 26000, summary: 'A fisherman, a marlin, the sea.', tags: { classic: {} },
    reading_progress: 0.1, published_date: null, parent_id: null, content: null, notes: null, updated_at: '2026-09-10T10:00:00Z',
    html_content: `<h1>The Old Man and the Sea</h1><p>Prefatory note.</p>${chapters('sea', 4, 'Sea')}`,
  },
  {
    id: 'doc-sleep', title: 'Why We Sleep, Briefly', author: 'Ada Lovelace', category: 'article', location: 'new',
    source_url: 'https://example.com/sleep', word_count: 1800, summary: 'Sleep debt and memory.', tags: {},
    reading_progress: 0, published_date: '2026-09-01', parent_id: null, content: null, notes: null, updated_at: '2026-09-12T08:00:00Z',
    html_content: '<p>Sleep is not a luxury. Adults need seven to nine hours, and the loss compounds.</p><p>Memory consolidation happens in the second half of the night, which is the half we skip.</p><p>Caffeine has a half-life of about six hours, so the afternoon coffee is still working at midnight.</p>',
  },
  {
    id: 'doc-pdf', title: 'Quarterly Report (PDF)', author: null, category: 'pdf', location: 'new',
    source_url: 'https://example.com/q.pdf', word_count: null, summary: null, tags: {},
    reading_progress: 0, published_date: null, parent_id: null, content: null, notes: null, updated_at: '2026-09-11T08:00:00Z',
    html_content: null,
  },
  {
    id: 'doc-old', title: 'An Archived Essay', author: 'Someone', category: 'article', location: 'archive',
    source_url: 'https://example.com/essay', word_count: 900, summary: null, tags: {},
    reading_progress: 1, published_date: null, parent_id: null, content: null, notes: null, updated_at: '2026-08-01T08:00:00Z',
    html_content: '<p>Done and dusted.</p>',
  },
]
// a highlight Reader already has on the book, to be adopted and painted
const highlights = [
  { id: 'hl-remote-1', category: 'highlight', parent_id: 'doc-sea', content: 'Sea paragraph 1.2.', notes: 'from Reader', location: 'later', updated_at: '2026-09-10T11:00:00Z', title: null, author: null, source_url: null, word_count: null, summary: null, tags: {}, reading_progress: null, published_date: null, html_content: null },
]
let nextHighlightId = 1000

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}
const strip = (d) => { const { html_content, ...rest } = d; return rest }

// ---- the scripted model ----
function agentReply(messages, context) {
  const last = messages[messages.length - 1]
  const text = typeof last.content === 'string' ? last.content : last.content.map((b) => b.type === 'text' ? b.text : b.type === 'tool_result' ? `[result:${b.content}]` : '').join(' ')
  const t = text.toLowerCase()
  const reply = (spoken, tool) => ({ content: [{ type: 'text', text: spoken }, ...(tool ? [{ type: 'tool_use', id: `tu-${Date.now()}`, name: tool.name, input: tool.input }] : [])] })
  if (t.includes('[the reader is looking at their library')) return reply('Hi. What would you like to read? The newest thing in your inbox is Why We Sleep, Briefly.')
  // the app already acted on a decision; a real model just acknowledges
  if (t.includes('[the app already did this:')) return reply('Okay.')
  if (!t.startsWith('[result:') && t.includes('open') && t.includes('hemingway')) return reply('', { name: 'search_library', input: { query: 'hemingway' } })
  if (t.startsWith('[result:') && t.includes('[doc-sea]') && !t.includes('opened')) return reply('Opening The Old Man and the Sea.', { name: 'open_document', input: { id: 'doc-sea' } })
  if (t.startsWith('[result:') && t.includes('opened "the old man')) return reply('Picking up where you left off.', { name: 'read_aloud', input: {} })
  if (t.includes('[the reader opened')) return reply('', { name: 'read_aloud', input: {} })
  if (t.includes('highlight that')) return reply('Highlighted.', { name: 'highlight', input: { text: context.nearbyText.split('\n\n').find((l) => l.startsWith(`[${context.currentParagraph}]`))?.replace(/^\[\d+\] /, '') ?? 'skiff', note: t.includes('note') ? 'for the talk' : undefined, anchor: context.currentParagraph } })
  if (t.includes('archive')) return reply('Archived.', { name: 'move_document', input: { location: 'archive' } })
  if (t.includes('what have i highlighted')) return reply('', { name: 'list_highlights', input: {} })
  if (t.includes('remove the last highlight')) return reply('', { name: 'list_highlights', input: {} })
  if (t.startsWith('[result:') && /\[h-[^\]]+\]/.test(text) && messages.some((m) => typeof m.content === 'string' && m.content.toLowerCase().includes('remove the last highlight')) && !t.includes('removed')) {
    const ids = [...text.matchAll(/\[(h-[^\]]+)\]/g)].map((m) => m[1])
    return reply('Removing it.', { name: 'remove_highlight', input: { id: ids[ids.length - 1] } })
  }
  if (t.includes('read the sleep article') || t.includes('open the sleep article')) return reply('Opening Why We Sleep.', { name: 'open_document', input: { id: 'doc-sleep' } })
  if (t.includes('open the report') || t.includes('open the pdf')) return reply('', { name: 'open_document', input: { id: 'doc-pdf' } })
  if (t.includes('save it for later') || t.includes('put it in later')) return reply('Saved for later.', { name: 'move_document', input: { location: 'later' } })
  if (t.includes('back to the library') || t.includes('close this')) return reply('Back to the library.', { name: 'close_document', input: {} })
  if (t.startsWith('[result:')) return reply('Done.')
  return reply(`I heard: ${text.slice(0, 60)}`)
}

// A stand-in for the decision model behind /api/navigate: keyword rules over
// the candidates the app sent, answered with the shape the real route returns.
// The interesting part is what the app does with a confident answer, not how
// the answer was reached.
function navigateReply({ text, screen, docs = [], chapters = [], shelves = [] }) {
  const t = text.toLowerCase()
  const decision = (intent, extra = {}) => ({ enabled: true, decision: { intent, confidence: 0.9, model: 'fake', ...extra } })
  const named = docs.find((d) => t.includes('hemingway') && /hemingway/i.test(d.author ?? '')) ?? docs.find((d) => t.includes('pdf') && /pdf/i.test(d.title)) ?? docs.find((d) => t.includes('sleep') && /sleep/i.test(d.title))
  if (/^(open|read|play|start)\b/.test(t) && named) return decision('open', { doc: { id: named.id, confidence: 0.85 } })
  if (screen === 'document') {
    const m = t.match(/chapter (\w+)/)
    if (m) {
      const n = { one: 1, two: 2, three: 3, four: 4 }[m[1]] ?? Number(m[1])
      const index = chapters.findIndex((c) => c.startsWith(`Chapter ${n}:`))
      if (index >= 0) return decision('chapter', { chapter: { index, confidence: 0.9 } })
    }
    if (/back to the library|close this/.test(t)) return decision('close')
    if (/archive/.test(t) && shelves.some((s) => s.id === 'archive')) return decision('file', { shelf: { id: 'archive', confidence: 0.9 } })
    if (/save it for later/.test(t) && shelves.some((s) => s.id === 'later')) return decision('file', { shelf: { id: 'later', confidence: 0.9 } })
    if (/^(hold on|wait|shush|that's enough)/.test(t)) return decision('pause')
  }
  if (screen === 'library' && /what's new|what is new/.test(t)) return decision('list')
  return decision('other', { confidence: 0.7 })
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)
  let body = ''
  for await (const c of req) body += c
  const auth = req.headers.authorization ?? ''
  log({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), auth: auth.slice(0, 12), body: body.slice(0, 40000) })
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS')
  if (req.method === 'OPTIONS') return res.writeHead(204).end()

  // Reader v3
  if (url.pathname === '/api/v3/list/') {
    if (!auth.startsWith('Token ')) return json(res, 401, { detail: 'no' })
    const q = url.searchParams
    let results = [...docs, ...highlights]
    if (q.get('id')) results = results.filter((d) => d.id === q.get('id'))
    if (q.get('location')) results = results.filter((d) => d.location === q.get('location'))
    if (q.get('category')) results = results.filter((d) => d.category === q.get('category'))
    if (q.get('updatedAfter')) results = results.filter((d) => d.updated_at > q.get('updatedAfter'))
    return json(res, 200, { count: results.length, nextPageCursor: null, results: q.get('withHtmlContent') ? results : results.map(strip) })
  }
  const m = url.pathname.match(/^\/api\/v3\/update\/([^/]+)\/$/)
  if (m && req.method === 'PATCH') {
    const d = docs.find((x) => x.id === m[1])
    if (!d) return json(res, 404, {})
    Object.assign(d, JSON.parse(body), { updated_at: new Date().toISOString() })
    return json(res, 200, strip(d))
  }
  // Readwise v2 highlights
  if (url.pathname === '/api/v2/highlights/' && req.method === 'POST') {
    const id = nextHighlightId++
    return json(res, 200, [{ id: 1, title: 'x', modified_highlights: [id] }])
  }
  if (/^\/api\/v2\/highlights\/\d+\/$/.test(url.pathname) && req.method === 'DELETE') return res.writeHead(204).end()

  // the app's own server
  if (url.pathname === '/api/agent' && req.method === 'POST') {
    const { messages, context } = JSON.parse(body)
    return json(res, 200, agentReply(messages, context))
  }
  if (url.pathname === '/api/navigate' && req.method === 'POST') return json(res, 200, navigateReply(JSON.parse(body)))
  if (url.pathname === '/api/factcheck' && req.method === 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
    res.write(JSON.stringify({ type: 'done', result: { verdict: 'accurate', summary: 'Checks out.', spokenSummary: 'That checks out.', sources: [] } }) + '\n')
    return res.end()
  }
  json(res, 404, { error: `no route ${req.method} ${url.pathname}` })
}).listen(PORT, () => log({ listening: PORT }))
