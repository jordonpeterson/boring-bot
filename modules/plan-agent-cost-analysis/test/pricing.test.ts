import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { PRICING, lookupPricing } from '../src/pricing.js'

describe('PRICING table', () => {
  test('contains entries for all major model families', () => {
    const expected = [
      'claude-opus-4-6', 'claude-opus-4-5', 'claude-opus-4-1', 'claude-opus-4',
      'claude-sonnet-4-6', 'claude-sonnet-4-5', 'claude-sonnet-4',
      'claude-haiku-4-5', 'claude-haiku-3-5', 'claude-haiku-3',
    ]
    for (const model of expected) {
      assert.ok(PRICING[model], `Missing pricing for ${model}`)
    }
  })

  test('all entries have positive rates', () => {
    for (const [model, entry] of Object.entries(PRICING)) {
      assert.ok(entry.inputPerMTok > 0, `${model}: inputPerMTok must be > 0`)
      assert.ok(entry.outputPerMTok > 0, `${model}: outputPerMTok must be > 0`)
      assert.ok(entry.cacheWrite5mPerMTok > 0, `${model}: cacheWrite5mPerMTok must be > 0`)
      assert.ok(entry.cacheWrite1hPerMTok > 0, `${model}: cacheWrite1hPerMTok must be > 0`)
      assert.ok(entry.cacheReadPerMTok > 0, `${model}: cacheReadPerMTok must be > 0`)
    }
  })

  test('output tokens are more expensive than input tokens', () => {
    for (const [model, entry] of Object.entries(PRICING)) {
      assert.ok(
        entry.outputPerMTok > entry.inputPerMTok,
        `${model}: output should be more expensive than input`,
      )
    }
  })

  test('cache reads are cheaper than regular input', () => {
    for (const [model, entry] of Object.entries(PRICING)) {
      assert.ok(
        entry.cacheReadPerMTok < entry.inputPerMTok,
        `${model}: cache reads should be cheaper than regular input`,
      )
    }
  })

  test('cache writes are more expensive than regular input', () => {
    for (const [model, entry] of Object.entries(PRICING)) {
      assert.ok(
        entry.cacheWrite5mPerMTok > entry.inputPerMTok,
        `${model}: 5m cache writes should be more expensive than input`,
      )
      assert.ok(
        entry.cacheWrite1hPerMTok > entry.cacheWrite5mPerMTok,
        `${model}: 1h cache writes should be more expensive than 5m`,
      )
    }
  })
})

describe('lookupPricing', () => {
  test('returns entry for exact model ID', () => {
    const entry = lookupPricing('claude-sonnet-4-5')
    assert.ok(entry)
    assert.equal(entry.inputPerMTok, 3.00)
  })

  test('strips date suffix and matches', () => {
    const entry = lookupPricing('claude-sonnet-4-5-20250929')
    assert.ok(entry)
    assert.equal(entry.inputPerMTok, 3.00)
  })

  test('returns null for unknown model', () => {
    const entry = lookupPricing('gpt-4o-mini')
    assert.equal(entry, null)
  })

  test('returns null for empty string', () => {
    assert.equal(lookupPricing(''), null)
  })

  test('handles model IDs with multiple hyphens', () => {
    const entry = lookupPricing('claude-opus-4-6')
    assert.ok(entry)
    assert.equal(entry.inputPerMTok, 5.00)
  })

  test('handles versioned opus models', () => {
    const entry = lookupPricing('claude-opus-4-1-20250410')
    assert.ok(entry)
    assert.equal(entry.inputPerMTok, 15.00)
  })

  test('does not false-match partial model names', () => {
    assert.equal(lookupPricing('claude-sonnet'), null)
    assert.equal(lookupPricing('claude'), null)
  })
})
