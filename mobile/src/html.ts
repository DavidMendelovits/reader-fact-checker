// Reader hands back article HTML; narration needs paragraphs of plain text.
// ponytail: regex extraction, no DOM dep — Reader's html_content is already
// Readability-cleaned, so block tags are honest. Swap for a real parser if a
// document ever comes out mangled.

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

/** Split HTML into readable paragraphs, dropping markup, scripts, and figures. */
export function htmlToParagraphs(html: string): string[] {
  const cleaned = html
    .replace(/<(script|style|figure|figcaption|noscript|svg)[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
  return cleaned
    .split(/<\/(?:p|h[1-6]|li|blockquote|div|td)>|<br\s*\/?>/i)
    .map((chunk) => decode(chunk.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim())
    .filter((text) => text.length > 1)
}
