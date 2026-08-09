import { Readability } from '@mozilla/readability'
import ePub from 'epubjs'
import type { Doc } from '../types'
import { apiFetch } from './api'

function htmlToParagraphs(container: Element | Document): string[] {
  const nodes = container.querySelectorAll('p, li, blockquote, h2, h3, h4')
  const out: string[] = []
  nodes.forEach((n) => {
    const text = (n.textContent ?? '').replace(/\s+/g, ' ').trim()
    // ponytail: 40-char floor filters nav junk and stray captions; good enough for a POC
    if (text.length >= 40) out.push(text)
  })
  return out
}

export async function extractFromUrl(url: string): Promise<Doc> {
  const res = await apiFetch(`/api/fetch?url=${encodeURIComponent(url)}`)
  if (!res.ok) throw new Error(`Could not fetch page (${res.status}): ${await res.text()}`)
  const html = await res.text()
  const dom = new DOMParser().parseFromString(html, 'text/html')
  // Readability needs a base URI for relative links to resolve; harmless if absent
  const article = new Readability(dom).parse()
  if (!article?.content) throw new Error('Readability could not extract an article from that page')
  const contentDom = new DOMParser().parseFromString(article.content, 'text/html')
  const paragraphs = htmlToParagraphs(contentDom)
  if (paragraphs.length === 0) throw new Error('No readable paragraphs found')
  return {
    id: `url:${url}`,
    title: article.title || url,
    source: url,
    chapters: [{ title: article.title || 'Article', paragraphs }],
  }
}

export async function extractFromEpub(file: File): Promise<Doc> {
  const book = ePub(await file.arrayBuffer())
  await book.ready
  const metadata = await book.loaded.metadata
  const spine = book.spine as unknown as { items: { href: string }[] }
  const toc = (await book.loaded.navigation)?.toc ?? []
  const tocByHref = new Map<string, string>()
  for (const item of toc) {
    tocByHref.set(item.href.split('#')[0], item.label.trim())
  }

  const chapters: Doc['chapters'] = []
  for (const item of spine.items) {
    let loaded: unknown
    try {
      loaded = await book.load(item.href)
    } catch {
      continue
    }
    // book.load returns a Document for xhtml sections, occasionally a string
    const docNode: Document =
      typeof loaded === 'string'
        ? new DOMParser().parseFromString(loaded, 'application/xhtml+xml')
        : (loaded as Document)
    const paragraphs = htmlToParagraphs(docNode)
    if (paragraphs.length === 0) continue
    const title =
      tocByHref.get(item.href.split('#')[0]) ??
      docNode.querySelector('h1, h2, title')?.textContent?.trim() ??
      `Section ${chapters.length + 1}`
    chapters.push({ title, paragraphs })
  }
  if (chapters.length === 0) throw new Error('No readable chapters found in EPUB')
  return { id: `epub:${file.name}`, title: metadata.title || file.name, source: file.name, chapters }
}
