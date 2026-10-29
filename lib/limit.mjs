// Runs fn over items with at most `limit` calls in flight, so a scan of thousands of files
// never holds all of them in memory at once.
export async function forEachLimit(items, limit, fn) {
  let next = 0;
  const worker = async () => { while (next < items.length) await fn(items[next++]); };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
