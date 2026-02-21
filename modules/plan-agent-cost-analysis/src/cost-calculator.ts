import type { PricingEntry, TokenUsage, RunningCost } from './types.js'
import { PRICING, lookupPricing } from './pricing.js'

/**
 * Calculates per-message and running-total costs from token usage.
 *
 * Uses a static pricing table.  When the model is unknown or absent
 * from the table, cost is reported as 0.
 */
export class CostCalculator {
  private readonly pricing: Record<string, PricingEntry>
  private running: RunningCost

  constructor(pricing?: Record<string, PricingEntry>) {
    this.pricing = pricing ?? PRICING
    this.running = this.emptyRunning()
  }

  /** Reset the running cost accumulator. */
  reset(): void {
    this.running = this.emptyRunning()
  }

  /** Get a snapshot of the current running totals. */
  getRunningCost(): RunningCost {
    return { ...this.running }
  }

  /**
   * Calculate the cost of a single message given its token usage and model.
   *
   * Uses the 5-minute cache write rate (most common for agent workloads).
   * Returns 0 when the model has no pricing entry.
   */
  calculate(usage: TokenUsage, model: string | null): number {
    if (!model) return 0

    const entry = this.lookupModel(model)
    if (!entry) return 0

    const inputCost   = (usage.inputTokens / 1_000_000) * entry.inputPerMTok
    const outputCost  = (usage.outputTokens / 1_000_000) * entry.outputPerMTok
    const cacheWrite  = (usage.cacheCreationInputTokens / 1_000_000) * entry.cacheWrite5mPerMTok
    const cacheRead   = (usage.cacheReadInputTokens / 1_000_000) * entry.cacheReadPerMTok

    return inputCost + outputCost + cacheWrite + cacheRead
  }

  /**
   * Update running totals with a new message's usage.  Returns the new
   * running cost snapshot.
   */
  updateRunningTotal(usage: TokenUsage, model: string | null): RunningCost {
    const cost = this.calculate(usage, model)
    this.running.totalCostUsd += cost
    this.running.totalInputTokens += usage.inputTokens
    this.running.totalOutputTokens += usage.outputTokens
    this.running.totalCacheCreationTokens += usage.cacheCreationInputTokens
    this.running.totalCacheReadTokens += usage.cacheReadInputTokens
    this.running.messageCount += 1
    return this.getRunningCost()
  }

  // ── Internals ─────────────────────────────────────────────────────

  private lookupModel(modelId: string): PricingEntry | null {
    // Try exact match against our copy first, fall back to the module-level lookup.
    if (this.pricing[modelId]) return this.pricing[modelId]
    return lookupPricing(modelId)
  }

  private emptyRunning(): RunningCost {
    return {
      totalCostUsd: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheCreationTokens: 0,
      totalCacheReadTokens: 0,
      messageCount: 0,
    }
  }
}
