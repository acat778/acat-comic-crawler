import assert from 'node:assert/strict'
import { getSegmentCount } from '../src/services/descramble.js'

function testUsesPhotoIdForHashSegmentation() {
  assert.equal(getSegmentCount({ scrambleId: 220980, imageId: 196790, filename: '00001.webp' }), 0)
  assert.equal(getSegmentCount({ scrambleId: 220980, imageId: 390371, filename: '00001.webp' }), 6)
}

function testUsesScrambleIdThreshold() {
  assert.equal(getSegmentCount({ scrambleId: 220980, imageId: 220979, filename: '00001.webp' }), 0)
  assert.equal(getSegmentCount({ scrambleId: 220980, imageId: 220980, filename: '00001.webp' }), 10)
}

testUsesPhotoIdForHashSegmentation()
testUsesScrambleIdThreshold()
