import type { PricingEntry } from './types.js'

/**
 * Anthropic model pricing table (USD per million tokens).
 *
 * Updated: 2026-02-21.  When Anthropic changes prices, add a new
 * dated snapshot and update the default export.
 */
export const PRICING: Record<string, PricingEntry> = {
  // ── Opus ───────────────────────────────────────────────────────────
  'claude-opus-4-6':       { inputPerMTok: 5.00,  outputPerMTok: 25.00, cacheWrite5mPerMTok: 6.25,  cacheWrite1hPerMTok: 10.00, cacheReadPerMTok: 0.50 },
  'claude-opus-4-5':       { inputPerMTok: 5.00,  outputPerMTok: 25.00, cacheWrite5mPerMTok: 6.25,  cacheWrite1hPerMTok: 10.00, cacheReadPerMTok: 0.50 },
  'claude-opus-4-1':       { inputPerMTok: 15.00, outputPerMTok: 75.00, cacheWrite5mPerMTok: 18.75, cacheWrite1hPerMTok: 30.00, cacheReadPerMTok: 1.50 },
  'claude-opus-4':         { inputPerMTok: 15.00, outputPerMTok: 75.00, cacheWrite5mPerMTok: 18.75, cacheWrite1hPerMTok: 30.00, cacheReadPerMTok: 1.50 },

  // ── Sonnet ─────────────────────────────────────────────────────────
  'claude-sonnet-4-6':     { inputPerMTok: 3.00,  outputPerMTok: 15.00, cacheWrite5mPerMTok: 3.75,  cacheWrite1hPerMTok: 6.00,  cacheReadPerMTok: 0.30 },
  'claude-sonnet-4-5':     { inputPerMTok: 3.00,  outputPerMTok: 15.00, cacheWrite5mPerMTok: 3.75,  cacheWrite1hPerMTok: 6.00,  cacheReadPerMTok: 0.30 },
  'claude-sonnet-4':       { inputPerMTok: 3.00,  outputPerMTok: 15.00, cacheWrite5mPerMTok: 3.75,  cacheWrite1hPerMTok: 6.00,  cacheReadPerMTok: 0.30 },

  // ── Haiku ──────────────────────────────────────────────────────────
  'claude-haiku-4-5':      { inputPerMTok: 1.00,  outputPerMTok: 5.00,  cacheWrite5mPerMTok: 1.25,  cacheWrite1hPerMTok: 2.00,  cacheReadPerMTok: 0.10 },
  'claude-haiku-3-5':      { inputPerMTok: 0.80,  outputPerMTok: 4.00,  cacheWrite5mPerMTok: 1.00,  cacheWrite1hPerMTok: 1.60,  cacheReadPerMTok: 0.08 },
  'claude-haiku-3':        { inputPerMTok: 0.25,  outputPerMTok: 1.25,  cacheWrite5mPerMTok: 0.30,  cacheWrite1hPerMTok: 0.50,  cacheReadPerMTok: 0.03 },
}

/**
 * Look up pricing for a model ID.  Handles both exact matches and
 * versioned slugs (e.g. "claude-sonnet-4-5-20250929" → "claude-sonnet-4-5").
 *
 * Returns `null` when the model is not in the table.
 */
export function lookupPricing(modelId: string): PricingEntry | null {
  // Try exact match first.
  if (PRICING[modelId]) return PRICING[modelId]

  // Strip date suffix (e.g. "-20250929") and try again.
  const withoutDate = modelId.replace(/-\d{8}$/, '')
  if (PRICING[withoutDate]) return PRICING[withoutDate]

  return null
}
