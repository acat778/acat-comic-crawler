import assert from 'node:assert/strict'
import { mapLimit, normalizeConcurrency } from '../src/services/concurrency.js'

async function testMapLimitCapsConcurrentWork() {
  let active = 0
  let maxActive = 0
  const result = await mapLimit([1, 2, 3, 4, 5], {
    concurrency: 2,
    worker: async (value) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active -= 1
      return value * 10
    },
  })

  assert.equal(maxActive, 2)
  assert.deepEqual(result, [10, 20, 30, 40, 50])
}

function testNormalizeConcurrencyBoundsValues() {
  assert.equal(normalizeConcurrency('4', 2), 4)
  assert.equal(normalizeConcurrency('0', 2), 2)
  assert.equal(normalizeConcurrency('bad', 2), 2)
  assert.equal(normalizeConcurrency('99', 2, 8), 8)
}

await testMapLimitCapsConcurrentWork()
testNormalizeConcurrencyBoundsValues()
