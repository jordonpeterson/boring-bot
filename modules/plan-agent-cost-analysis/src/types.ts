import type { SDKMessage, StreamEvent } from '@boring-bot/code-executor'

// Re-export the upstream types for convenience.
export type { SDKMessage, StreamEvent }

// ─── Pricing ────────────────────────────────────────────────────────────────

/** Per-model pricing rates (USD per million tokens). */
export interface PricingEntry {
  inputPerMTok: number
  outputPerMTok: number
  cacheWrite5mPerMTok: number
  cacheWrite1hPerMTok: number
  cacheReadPerMTok: number
}

// ─── Token usage ────────────────────────────────────────────────────────────

/** Normalised token counts for a single message or aggregate. */
export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
}

/** Running cost accumulator returned after each ingested event. */
export interface RunningCost {
  totalCostUsd: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheCreationTokens: number
  totalCacheReadTokens: number
  messageCount: number
}

// ─── Tool calls ─────────────────────────────────────────────────────────────

/** A single tool invocation extracted from an assistant message. */
export interface ToolCall {
  toolName: string
  toolId: string
  input: Record<string, unknown>
}

/** Aggregate stats for a single tool name. */
export interface ToolCallSummary {
  count: number
  toolIds: string[]
}

// ─── Per-model usage (from SDKResultMessage) ────────────────────────────────

/** Per-model usage as reported by the SDK result message. */
export interface ModelUsageEntry {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  webSearchRequests: number
  costUSD: number
  contextWindow: number
}

// ─── Ingested event ─────────────────────────────────────────────────────────

/** Normalised record produced by EventIngester for each meaningful SDK event. */
export interface AgentEvent {
  eventId: string
  sessionId: string
  timestamp: number
  type: string
  subtype: string | null
  model: string | null
  messageId: string | null
  parentToolUseId: string | null
  usage: TokenUsage | null
  toolCalls: ToolCall[]
  costUsd: number
}

// ─── Session summary ────────────────────────────────────────────────────────

export interface SessionSummaryData {
  sessionId: string
  model: string | null
  status: string
  durationMs: number
  durationApiMs: number
  numTurns: number
  totalCostUsd: number
  computedCostUsd: number
  tokenUsage: TokenUsage
  modelUsage: Record<string, ModelUsageEntry>
  toolCallSummary: Record<string, ToolCallSummary>
  permissionDenials: number
  compactions: number
  errors: string[]
}
