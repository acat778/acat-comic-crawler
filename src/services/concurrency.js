export function normalizeConcurrency(value, fallback, max = 20) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) return fallback
  return Math.min(parsed, max)
}

export async function mapLimit(items, options) {
  const { concurrency, signal, worker } = options
  const limit = normalizeConcurrency(concurrency, 1)
  const results = new Array(items.length)
  let nextIndex = 0

  async function runWorker() {
    while (nextIndex < items.length && !signal?.aborted) {
      const index = nextIndex
      nextIndex += 1
      results[index] = await worker(items[index], index)
    }
  }

  const workerCount = Math.min(limit, items.length)
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()))
  return results
}

