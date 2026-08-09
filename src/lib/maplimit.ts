/**
 * Run `task` over every item, at most `limit` at a time, in input order.
 *
 * `cancelled` is polled before each item is picked up, so a long scan stops at the
 * next boundary rather than running to completion in the background. Items skipped
 * that way leave empty slots — `flat()` and `filter()` drop them, index-based access
 * would not.
 */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
  cancelled: () => boolean = () => false,
): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
      for (;;) {
        const i = next++
        if (i >= items.length || cancelled()) return
        out[i] = await task(items[i], i)
      }
    }),
  )
  return out
}
