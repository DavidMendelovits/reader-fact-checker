// Reader hands back article and book HTML; narration needs chapters of plain
// paragraphs. Regex extraction, no DOM dep — Reader's html_content is already
// cleaned, so block tags are honest. Swap for a real parser if a document ever
// comes out mangled.
//
// Runs under node for the self-check, so nothing from react-native in here.
import type { Chapter } from './types'

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“',
  mdash: '—', ndash: '–', hellip: '…',
}

function decode(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m)
}

const strip = (html: string) =>
  html
    .replace(/<(script|style|figure|figcaption|noscript|svg|nav|header|footer)[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')

const toText = (chunk: string) => decode(chunk.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()

/** Split HTML into readable paragraphs, dropping markup, scripts, and figures. */
export function htmlToParagraphs(html: string): string[] {
  return strip(html)
    .split(/<\/(?:p|h[1-6]|li|blockquote|div|td|dd|dt|pre)>|<br\s*\/?>/i)
    .map(toText)
    .filter((text) => text.length > 1)
}

// A heading that opens a chapter. h1-h3 only: deeper headings are sub-sections
// and would fragment a book into hundreds of two-paragraph "chapters".
const HEADING = /<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/gi

/**
 * Split HTML into chapters at its headings. The heading becomes the chapter's
 * title and its first paragraph, so it is read aloud and the agent can jump to
 * it by name. Text before the first heading is a chapter titled after the
 * document. No headings, one chapter.
 */
export function htmlToChapters(html: string, docTitle: string): Chapter[] {
  const clean = strip(html)
  const out: Chapter[] = []
  let title = docTitle
  let last = 0
  const push = (chunk: string, chapterTitle: string, includeTitle: boolean) => {
    const paragraphs = htmlToParagraphs(chunk)
    if (includeTitle && chapterTitle && paragraphs[0] !== chapterTitle) paragraphs.unshift(chapterTitle)
    if (paragraphs.length > 0) out.push({ title: chapterTitle || docTitle, paragraphs })
  }
  for (const m of clean.matchAll(HEADING)) {
    push(clean.slice(last, m.index), title, out.length > 0)
    title = toText(m[2]) || title
    last = (m.index ?? 0) + m[0].length
  }
  push(clean.slice(last), title, out.length > 0 || last > 0)
  if (out.length === 0) return [{ title: docTitle, paragraphs: [] }]
  return out
}
