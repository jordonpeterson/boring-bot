import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { CostCalculator } from '../src/cost-calculator.js'
import type { TokenUsage, PricingEntry } from '../src/types.js'

const simplePricing: Record<string, PricingEntry> = {
  'test-model': {
    inputPerMTok: 10.00,    // $10 per MTok
    outputPerMTok: 20.00,   // $20 per MTok
    cacheWrite5mPerMTok: 12.50,
    cacheWrite1hPerMTok: 20.00,
    cacheReadPerMTok: 1.00,
  },
}

function makeUsage(overrides: Partial<TokenUsage> = {}): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    ...overrides,
  }
}

describe('CostCalculator.calculate', () => {
  test('calculates cost for input tokens only', () => {
    const calc = new CostCalculator(simplePricing)
    const usage = makeUsage({ inputTokens: 1_000_000 })
    const cost = calc.calculate(usage, 'test-model')
    assert.equal(cost, 10.00)
  })

  test('calculates cost for output tokens only', () => {
    const calc = new CostCalculator(simplePricing)
    const usage = makeUsage({ outputTokens: 1_000_000 })
    const cost = calc.calculate(usage, 'test-model')
    assert.equal(cost, 20.00)
  })

  test('calculates cost for cache creation tokens', () => {
    const calc = new CostCalculator(simplePricing)
    const usage = makeUsage({ cacheCreationInputTokens: 1_000_000 })
    const cost = calc.calculate(usage, 'test-model')
    assert.equal(cost, 12.50)
  })

  test('calculates cost for cache read tokens', () => {
    const calc = new CostCalculator(simplePricing)
    const usage = makeUsage({ cacheReadInputTokens: 1_000_000 })
    const cost = calc.calculate(usage, 'test-model')
    assert.equal(cost, 1.00)
  })

  test('sums all token categories', () => {
    const calc = new CostCalculator(simplePricing)
    const usage = makeUsage({
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheCreationInputTokens: 1_000_000,
      cacheReadInputTokens: 1_000_000,
    })
    const cost = calc.calculate(usage, 'test-model')
    assert.equal(cost, 10.00 + 20.00 + 12.50 + 1.00)
  })

  test('returns 0 for null model', () => {
    const calc = new CostCalculator(simplePricing)
    const usage = makeUsage({ inputTokens: 1_000_000 })
    assert.equal(calc.calculate(usage, null), 0)
  })

  test('returns 0 for unknown model', () => {
    const calc = new CostCalculator(simplePricing)
    const usage = makeUsage({ inputTokens: 1_000_000 })
    assert.equal(calc.calculate(usage, 'unknown-model'), 0)
  })

  test('returns 0 for zero tokens', () => {
    const calc = new CostCalculator(simplePricing)
    const usage = makeUsage()
    assert.equal(calc.calculate(usage, 'test-model'), 0)
  })

  test('handles fractional token counts', () => {
    const calc = new CostCalculator(simplePricing)
    const usage = makeUsage({ inputTokens: 500_000 }) // half a million
    const cost = calc.calculate(usage, 'test-model')
    assert.equal(cost, 5.00) // $10/MTok * 0.5 MTok
  })

  test('handles small token counts precisely', () => {
    const calc = new CostCalculator(simplePricing)
    const usage = makeUsage({ inputTokens: 1 }) // 1 token
    const cost = calc.calculate(usage, 'test-model')
    assert.ok(cost > 0, 'even 1 token should have non-zero cost')
    assert.ok(Math.abs(cost - 0.00001) < 1e-10, `expected ~0.00001, got ${cost}`)
  })

  test('falls back to global PRICING table for known models', () => {
    const calc = new CostCalculator({}) // empty custom pricing
    const usage = makeUsage({ inputTokens: 1_000_000 })
    const cost = calc.calculate(usage, 'claude-sonnet-4-5')
    assert.equal(cost, 3.00) // from global PRICING
  })

  test('resolves versioned model IDs', () => {
    const calc = new CostCalculator({})
    const usage = makeUsage({ inputTokens: 1_000_000 })
    const cost = calc.calculate(usage, 'claude-sonnet-4-5-20250929')
    assert.equal(cost, 3.00)
  })
})

describe('CostCalculator.updateRunningTotal', () => {
  test('accumulates cost across multiple messages', () => {
    const calc = new CostCalculator(simplePricing)
    const usage = makeUsage({ inputTokens: 1_000_000 })

    calc.updateRunningTotal(usage, 'test-model')
    calc.updateRunningTotal(usage, 'test-model')
    calc.updateRunningTotal(usage, 'test-model')

    const running = calc.getRunningCost()
    assert.equal(running.totalCostUsd, 30.00)
    assert.equal(running.totalInputTokens, 3_000_000)
    assert.equal(running.messageCount, 3)
  })

  test('accumulates all token categories', () => {
    const calc = new CostCalculator(simplePricing)
    const usage = makeUsage({
      inputTokens: 100,
      outputTokens: 200,
      cacheCreationInputTokens: 300,
      cacheReadInputTokens: 400,
    })

    calc.updateRunningTotal(usage, 'test-model')
    calc.updateRunningTotal(usage, 'test-model')

    const running = calc.getRunningCost()
    assert.equal(running.totalInputTokens, 200)
    assert.equal(running.totalOutputTokens, 400)
    assert.equal(running.totalCacheCreationTokens, 600)
    assert.equal(running.totalCacheReadTokens, 800)
    assert.equal(running.messageCount, 2)
  })

  test('returns snapshot not reference', () => {
    const calc = new CostCalculator(simplePricing)
    const snapshot1 = calc.getRunningCost()
    calc.updateRunningTotal(makeUsage({ inputTokens: 1_000_000 }), 'test-model')
    const snapshot2 = calc.getRunningCost()

    assert.equal(snapshot1.totalCostUsd, 0)
    assert.equal(snapshot2.totalCostUsd, 10.00)
  })

  test('reset clears all running totals', () => {
    const calc = new CostCalculator(simplePricing)
    calc.updateRunningTotal(makeUsage({ inputTokens: 1_000_000 }), 'test-model')

    calc.reset()

    const running = calc.getRunningCost()
    assert.equal(running.totalCostUsd, 0)
    assert.equal(running.totalInputTokens, 0)
    assert.equal(running.messageCount, 0)
  })
})
