import type {
  AgentEvent,
  ModelUsageEntry,
  SessionSummaryData,
  TokenUsage,
  ToolCallSummary,
} from './types.js'
import type { CostCalculator } from './cost-calculator.js'
import type { ToolAggregator } from './tool-aggregator.js'

/**
 * Materialises a SessionSummaryData from accumulated agent events
 * and the authoritative SDK result message.
 */
export function buildSessionSummary(
  events: AgentEvent[],
  resultMessage: Record<string, unknown> | null,
  calculator: CostCalculator,
  aggregator: ToolAggregator,
): SessionSummaryData {
  const sessionId = findSessionId(events)
  const model = findModel(events)

  // Aggregate token usage from per-message events.
  const computedUsage = aggregateUsage(events)
  const computedCostUsd = calculator.getRunningCost().totalCostUsd

  // Extract authoritative data from the result message.
  const status = resultMessage
    ? ((resultMessage['subtype'] as string) ?? 'unknown')
    : 'incomplete'
  const totalCostUsd = (resultMessage?.['total_cost_usd'] as number) ?? computedCostUsd
  const durationMs = (resultMessage?.['duration_ms'] as number) ?? 0
  const durationApiMs = (resultMessage?.['duration_api_ms'] as number) ?? 0
  const numTurns = (resultMessage?.['num_turns'] as number) ?? countTurns(events)
  const permissionDenials = Array.isArray(resultMessage?.['permission_denials'])
    ? (resultMessage['permission_denials'] as unknown[]).length
    : 0

  // Extract per-model usage from the result, if present.
  const modelUsage = extractModelUsage(resultMessage)

  // Extract errors.
  const errors = Array.isArray(resultMessage?.['errors'])
    ? (resultMessage['errors'] as string[])
    : []

  // Count compactions.
  const compactions = events.filter(
    (e) => e.type === 'system' && e.subtype === 'compact_boundary',
  ).length

  // Authoritative usage from result if available, otherwise computed.
  const tokenUsage = extractResultUsage(resultMessage) ?? computedUsage

  return {
    sessionId,
    model,
    status,
    durationMs,
    durationApiMs,
    numTurns,
    totalCostUsd,
    computedCostUsd,
    tokenUsage,
    modelUsage,
    toolCallSummary: aggregator.getSummary(),
    permissionDenials,
    compactions,
    errors,
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function findSessionId(events: AgentEvent[]): string {
  for (const e of events) {
    if (e.sessionId) return e.sessionId
  }
  return ''
}

function findModel(events: AgentEvent[]): string | null {
  for (const e of events) {
    if (e.model) return e.model
  }
  return null
}

function countTurns(events: AgentEvent[]): number {
  return events.filter((e) => e.type === 'assistant').length
}

function aggregateUsage(events: AgentEvent[]): TokenUsage {
  const totals: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  }
  for (const e of events) {
    if (e.usage) {
      totals.inputTokens += e.usage.inputTokens
      totals.outputTokens += e.usage.outputTokens
      totals.cacheCreationInputTokens += e.usage.cacheCreationInputTokens
      totals.cacheReadInputTokens += e.usage.cacheReadInputTokens
    }
  }
  return totals
}

function extractResultUsage(msg: Record<string, unknown> | null): TokenUsage | null {
  if (!msg) return null
  const usage = msg['usage'] as Record<string, unknown> | undefined
  if (!usage) return null
  return {
    inputTokens: (usage['input_tokens'] as number) ?? 0,
    outputTokens: (usage['output_tokens'] as number) ?? 0,
    cacheCreationInputTokens: (usage['cache_creation_input_tokens'] as number) ?? 0,
    cacheReadInputTokens: (usage['cache_read_input_tokens'] as number) ?? 0,
  }
}

function extractModelUsage(msg: Record<string, unknown> | null): Record<string, ModelUsageEntry> {
  if (!msg) return {}
  const raw = msg['modelUsage'] as Record<string, Record<string, unknown>> | undefined
  if (!raw) return {}

  const result: Record<string, ModelUsageEntry> = {}
  for (const [modelName, data] of Object.entries(raw)) {
    result[modelName] = {
      inputTokens: (data['inputTokens'] as number) ?? 0,
      outputTokens: (data['outputTokens'] as number) ?? 0,
      cacheReadInputTokens: (data['cacheReadInputTokens'] as number) ?? 0,
      cacheCreationInputTokens: (data['cacheCreationInputTokens'] as number) ?? 0,
      webSearchRequests: (data['webSearchRequests'] as number) ?? 0,
      costUSD: (data['costUSD'] as number) ?? 0,
      contextWindow: (data['contextWindow'] as number) ?? 0,
    }
  }
  return result
}
