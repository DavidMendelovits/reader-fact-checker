// Article import needs an HTML proxy to dodge CORS. Not a provider — there is
// nothing to swap — so it lives here rather than behind a port.
export async function fetchArticle(url: string): Promise<{ html: string; finalUrl: string }> {
  if (!/^https?:\/\//.test(url)) throw new Error('invalid url')
  const upstream = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (reader-fact-checker POC)' },
    redirect: 'follow',
  })
  return { html: await upstream.text(), finalUrl: upstream.url }
}
