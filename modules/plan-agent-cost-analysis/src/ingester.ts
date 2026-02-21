import type { SDKMessage } from '@boring-bot/code-executor'
import type { AgentEvent, ToolCall, TokenUsage } from './types.js'
import { CostCalculator } from './cost-calculator.js'

let nextEventId = 0

/**
 * Consumes one SDKMessage at a time and produces normalised AgentEvent records.
 *
 * De-duplicates by `message.id` (assistant messages with multiple content blocks
 * share one ID and report identical usage — we only count them once).
 */
export class EventIngester {
  private readonly seenMessageIds = new Set<string>()
  private readonly calculator: CostCalculator
  private model: string | null = null
  private sessionId: string | null = null

  constructor(calculator: CostCalculator) {
    this.calculator = calculator
  }

  /** Reset state for a new session. */
  reset(): void {
    this.seenMessageIds.clear()
    this.model = null
    this.sessionId = null
    nextEventId = 0
  }

  /** The model extracted from the init system message (if received). */
  getModel(): string | null {
    return this.model
  }

  /** The session ID extracted from the first message that carries one. */
  getSessionId(): string | null {
    return this.sessionId
  }

  /**
   * Ingest a single SDK message and return a normalised AgentEvent.
   *
   * Returns `null` when the message does not produce a new record:
   * - Duplicate assistant message (same `message.id`)
   * - Stream events (partial messages)
   * - Unknown / unhandled message types
   */
  ingest(message: SDKMessage): AgentEvent | null {
    // We need to work with the raw shape since SDKMessage is an opaque union
    // from the SDK.  Cast to `any` to access discriminated fields.
    const msg = message as Record<string, unknown>
    const type = msg['type'] as string | undefined
    if (!type) return null

    // Capture session ID from the first message that carries one.
    const sid = msg['session_id'] as string | undefined
    if (sid && !this.sessionId) {
      this.sessionId = sid
    }

    switch (type) {
      case 'system':
        return this.handleSystem(msg)
      case 'assistant':
        return this.handleAssistant(msg)
      case 'user':
        return this.handleUser(msg)
      case 'result':
        return this.handleResult(msg)
      case 'stream_event':
        // Partial assistant messages — skip.
        return null
      default:
        // Unknown / unhandled (hook_started, tool_progress, auth_status, …)
        return null
    }
  }

  // ── Handlers ──────────────────────────────────────────────────────

  private handleSystem(msg: Record<string, unknown>): AgentEvent | null {
    const subtype = msg['subtype'] as string | undefined

    if (subtype === 'init') {
      this.model = (msg['model'] as string) ?? null
      return this.makeEvent({
        sessionId: (msg['session_id'] as string) ?? '',
        type: 'system',
        subtype: 'init',
        model: this.model,
      })
    }

    if (subtype === 'compact_boundary') {
      return this.makeEvent({
        sessionId: (msg['session_id'] as string) ?? '',
        type: 'system',
        subtype: 'compact_boundary',
      })
    }

    return null
  }

  private handleAssistant(msg: Record<string, unknown>): AgentEvent | null {
    const inner = msg['message'] as Record<string, unknown> | undefined
    if (!inner) return null

    const messageId = inner['id'] as string | undefined

    // Deduplicate: multiple content blocks share the same message ID.
    if (messageId) {
      if (this.seenMessageIds.has(messageId)) return null
      this.seenMessageIds.add(messageId)
    }

    // Extract usage.
    const rawUsage = inner['usage'] as Record<string, unknown> | undefined
    const usage = rawUsage ? normaliseUsage(rawUsage) : null

    // Extract tool calls from content blocks.
    const content = inner['content'] as Array<Record<string, unknown>> | undefined
    const toolCalls = extractToolCalls(content)

    // Determine model from message if available.
    const model = (inner['model'] as string) ?? this.model

    // Compute cost for this message.
    const costUsd = usage ? this.calculator.calculate(usage, model) : 0

    return this.makeEvent({
      sessionId: (msg['session_id'] as string) ?? '',
      type: 'assistant',
      subtype: null,
      model,
      messageId: messageId ?? null,
      parentToolUseId: (msg['parent_tool_use_id'] as string) ?? null,
      usage,
      toolCalls,
      costUsd,
    })
  }

  private handleUser(msg: Record<string, unknown>): AgentEvent | null {
    return this.makeEvent({
      sessionId: (msg['session_id'] as string) ?? '',
      type: 'user',
      subtype: null,
      parentToolUseId: (msg['parent_tool_use_id'] as string) ?? null,
    })
  }

  private handleResult(msg: Record<string, unknown>): AgentEvent | null {
    const subtype = (msg['subtype'] as string) ?? 'unknown'
    const totalCostUsd = (msg['total_cost_usd'] as number) ?? 0

    return this.makeEvent({
      sessionId: (msg['session_id'] as string) ?? '',
      type: 'result',
      subtype,
      costUsd: totalCostUsd,
    })
  }

  // ── Helpers ───────────────────────────────────────────────────────

  private makeEvent(partial: Partial<AgentEvent> & { type: string }): AgentEvent {
    return {
      eventId: `evt_${nextEventId++}`,
      sessionId: partial.sessionId ?? this.sessionId ?? '',
      timestamp: Date.now(),
      type: partial.type,
      subtype: partial.subtype ?? null,
      model: partial.model ?? this.model,
      messageId: partial.messageId ?? null,
      parentToolUseId: partial.parentToolUseId ?? null,
      usage: partial.usage ?? null,
      toolCalls: partial.toolCalls ?? [],
      costUsd: partial.costUsd ?? 0,
    }
  }
}

// ─── Utility functions ────────────────────────────────────────────────────

function normaliseUsage(raw: Record<string, unknown>): TokenUsage {
  return {
    inputTokens: (raw['input_tokens'] as number) ?? 0,
    outputTokens: (raw['output_tokens'] as number) ?? 0,
    cacheCreationInputTokens: (raw['cache_creation_input_tokens'] as number) ?? 0,
    cacheReadInputTokens: (raw['cache_read_input_tokens'] as number) ?? 0,
  }
}

function extractToolCalls(
  content: Array<Record<string, unknown>> | undefined,
): ToolCall[] {
  if (!content) return []
  const calls: ToolCall[] = []
  for (const block of content) {
    if (block['type'] === 'tool_use') {
      calls.push({
        toolName: (block['name'] as string) ?? 'unknown',
        toolId: (block['id'] as string) ?? 'unknown',
        input: (block['input'] as Record<string, unknown>) ?? {},
      })
    }
  }
  return calls
}
