import type { ToolCall, ToolCallSummary } from './types.js'

/**
 * Tracks tool invocations across a session and produces aggregate stats.
 */
export class ToolAggregator {
  private readonly calls = new Map<string, ToolCallSummary>()

  /** Record one or more tool calls from a single assistant message. */
  record(toolCalls: ToolCall[]): void {
    for (const call of toolCalls) {
      const existing = this.calls.get(call.toolName)
      if (existing) {
        existing.count += 1
        existing.toolIds.push(call.toolId)
      } else {
        this.calls.set(call.toolName, {
          count: 1,
          toolIds: [call.toolId],
        })
      }
    }
  }

  /** Get the summary for a single tool, or undefined if never called. */
  get(toolName: string): ToolCallSummary | undefined {
    const entry = this.calls.get(toolName)
    return entry ? { ...entry, toolIds: [...entry.toolIds] } : undefined
  }

  /** Get aggregate summaries keyed by tool name. */
  getSummary(): Record<string, ToolCallSummary> {
    const result: Record<string, ToolCallSummary> = {}
    for (const [name, summary] of this.calls) {
      result[name] = { ...summary, toolIds: [...summary.toolIds] }
    }
    return result
  }

  /** Total number of tool calls across all tools. */
  getTotalCount(): number {
    let total = 0
    for (const summary of this.calls.values()) {
      total += summary.count
    }
    return total
  }

  /** List of unique tool names that have been called. */
  getToolNames(): string[] {
    return [...this.calls.keys()]
  }

  /** Reset all state. */
  reset(): void {
    this.calls.clear()
  }
}
