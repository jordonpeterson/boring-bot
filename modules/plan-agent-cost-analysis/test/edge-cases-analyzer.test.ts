/**
 * Edge-case tests for the Analyzer and SessionSummary components.
 *
 * These tests target unusual, boundary, and adversarial scenarios that
 * go beyond the happy-path lifecycle covered in analyzer.test.ts.
 *
 * Research context:
 *   - Sub-agents produce SDKMessages with a non-null parent_tool_use_id
 *     linking back to the tool_use block that spawned the sub-agent.
 *   - Multiple compact_boundary events can occur in a single long session
 *     (triggered automatically at ~98% context usage).
 *   - SDKResultMessage.modelUsage is a per-model breakdown keyed by model
 *     name; it can contain entries for main agent + sub-agent models.
 *   - Sub-agents cannot spawn further sub-agents, so nesting is max 1 level.
 *
 * Sources:
 *   https://platform.claude.com/docs/en/agent-sdk/subagents
 *   https://platform.claude.com/docs/en/agent-sdk/cost-tracking
 *   https://platform.claude.com/docs/en/agent-sdk/typescript
 *   https://platform.claude.com/docs/en/build-with-claude/compaction
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { Analyzer, createAnalyzer } from '../src/analyzer.js'
import { buildSessionSummary } from '../src/session-summary.js'
import { CostCalculator } from '../src/cost-calculator.js'
import { ToolAggregator } from '../src/tool-aggregator.js'
import type { AgentEvent, StreamEvent, SDKMessage } from '../src/types.js'
import {
  makeSystemInit,
  makeCompactBoundary,
  makeAssistantTextOnly,
  makeAssistantWithToolUse,
  makeAssistantMultiTool,
  makeUserMessage,
  makeResultSuccess,
  makeResultError,
  makeStreamEvent,
  wrapAsStreamEvent,
} from './fixtures.js'

// ─── Local helpers ───────────────────────────────────────────────────────────

/** Build a minimal AgentEvent for direct buildSessionSummary tests. */
function makeAgentEvent(partial: Partial<AgentEvent>): AgentEvent {
  return {
    eventId: 'evt_0',
    sessionId: 'sess-1',
    timestamp: Date.now(),
    type: 'assistant',
    subtype: null,
    model: 'claude-sonnet-4-5',
    messageId: null,
    parentToolUseId: null,
    usage: null,
    toolCalls: [],
    costUsd: 0,
    ...partial,
  }
}

/** Generate a unique message ID. */
let msgCounter = 0
function uniqueMsgId(): string {
  return `edge-msg-${++msgCounter}`
}

// ─── 1. Processing events out of order (result before init) ──────────────────

describe('Edge: events out of order', () => {
  test('result message processed before system init does not crash', () => {
    const analyzer = createAnalyzer()

    // Process result first — no init has been seen yet.
    const r1 = analyzer.processMessage(makeResultSuccess())
    assert.ok(r1.event, 'result should still produce an event')
    assert.equal(r1.isResult, true)

    // Now process init.
    const r2 = analyzer.processMessage(makeSystemInit())
    assert.ok(r2.event)
    assert.equal(r2.event.type, 'system')

    const summary = analyzer.getSessionSummary()
    // The result was captured even though init came later.
    assert.equal(summary.status, 'success')
  })

  test('assistant message before init still records usage', () => {
    const analyzer = createAnalyzer()

    const r = analyzer.processMessage(makeAssistantTextOnly({
      messageId: uniqueMsgId(),
      inputTokens: 500,
      outputTokens: 100,
    }))

    assert.ok(r.event)
    assert.ok(r.runningCost.totalInputTokens === 500)
    assert.ok(r.runningCost.totalOutputTokens === 100)
  })

  test('user message before any assistant still tracked', () => {
    const analyzer = createAnalyzer()

    const r = analyzer.processMessage(makeUserMessage())
    assert.ok(r.event)
    assert.equal(r.event.type, 'user')
    assert.equal(analyzer.getEvents().length, 1)
  })
})

// ─── 2. Empty event list for session summary ────────────────────────────────

describe('Edge: empty event list', () => {
  test('getSessionSummary with zero events returns sensible defaults', () => {
    const analyzer = createAnalyzer()
    const summary = analyzer.getSessionSummary()

    assert.equal(summary.sessionId, '')
    assert.equal(summary.model, null)
    assert.equal(summary.status, 'incomplete')
    assert.equal(summary.durationMs, 0)
    assert.equal(summary.durationApiMs, 0)
    assert.equal(summary.numTurns, 0)
    assert.equal(summary.totalCostUsd, 0)
    assert.equal(summary.computedCostUsd, 0)
    assert.equal(summary.tokenUsage.inputTokens, 0)
    assert.equal(summary.tokenUsage.outputTokens, 0)
    assert.equal(summary.tokenUsage.cacheCreationInputTokens, 0)
    assert.equal(summary.tokenUsage.cacheReadInputTokens, 0)
    assert.deepEqual(summary.modelUsage, {})
    assert.deepEqual(summary.toolCallSummary, {})
    assert.equal(summary.permissionDenials, 0)
    assert.equal(summary.compactions, 0)
    assert.deepEqual(summary.errors, [])
  })

  test('buildSessionSummary with empty array and null result', () => {
    const calculator = new CostCalculator()
    const aggregator = new ToolAggregator()
    const summary = buildSessionSummary([], null, calculator, aggregator)

    assert.equal(summary.sessionId, '')
    assert.equal(summary.model, null)
    assert.equal(summary.status, 'incomplete')
    assert.equal(summary.numTurns, 0)
    assert.equal(summary.compactions, 0)
  })
})

// ─── 3. Session with only system init and no other messages ─────────────────

describe('Edge: init-only session', () => {
  test('session with only a system init message', () => {
    const analyzer = createAnalyzer()
    analyzer.processMessage(makeSystemInit())

    const summary = analyzer.getSessionSummary()
    assert.equal(summary.sessionId, 'sess-1')
    assert.equal(summary.model, 'claude-sonnet-4-5-20250929')
    assert.equal(summary.status, 'incomplete')
    assert.equal(summary.numTurns, 0)
    assert.equal(summary.totalCostUsd, 0)
    assert.equal(summary.computedCostUsd, 0)
    assert.equal(summary.tokenUsage.inputTokens, 0)
    assert.equal(summary.tokenUsage.outputTokens, 0)
  })

  test('session with init and compact_boundary but no assistant messages', () => {
    const analyzer = createAnalyzer()
    analyzer.processMessage(makeSystemInit())
    analyzer.processMessage(makeCompactBoundary())

    const summary = analyzer.getSessionSummary()
    assert.equal(summary.status, 'incomplete')
    assert.equal(summary.compactions, 1)
    assert.equal(summary.numTurns, 0)
  })
})

// ─── 4. Session with multiple result messages ────────────────────────────────

describe('Edge: multiple result messages', () => {
  test('second result message overwrites the first for summary', () => {
    const analyzer = createAnalyzer()
    analyzer.processMessage(makeSystemInit())
    analyzer.processMessage(makeAssistantTextOnly({ messageId: uniqueMsgId() }))

    // First result.
    analyzer.processMessage(makeResultSuccess({ totalCostUsd: 0.01, numTurns: 1 }))

    // Second result (simulating an unexpected duplicate or resumed session).
    analyzer.processMessage(makeResultSuccess({
      totalCostUsd: 0.05,
      numTurns: 3,
      sessionId: 'sess-1',
    }))

    const summary = analyzer.getSessionSummary()
    // The last result message wins because processMessage overwrites this.resultMessage.
    assert.equal(summary.totalCostUsd, 0.05)
    assert.equal(summary.numTurns, 3)
  })

  test('both result events are counted in getEvents()', () => {
    const analyzer = createAnalyzer()
    analyzer.processMessage(makeSystemInit())
    analyzer.processMessage(makeResultSuccess({ totalCostUsd: 0.01 }))
    analyzer.processMessage(makeResultSuccess({ totalCostUsd: 0.02 }))

    const events = analyzer.getEvents()
    const resultEvents = events.filter((e) => e.type === 'result')
    assert.equal(resultEvents.length, 2)
  })
})

// ─── 5. Session with many compactions (context window management) ────────────

describe('Edge: multiple compactions', () => {
  test('counts many compaction boundaries correctly', () => {
    const analyzer = createAnalyzer()
    analyzer.processMessage(makeSystemInit())

    const numCompactions = 7
    for (let i = 0; i < numCompactions; i++) {
      // Simulate: assistant message, then compaction when near limit.
      analyzer.processMessage(makeAssistantTextOnly({
        messageId: uniqueMsgId(),
        inputTokens: 180_000,
        outputTokens: 2000,
      }))
      analyzer.processMessage(makeCompactBoundary(195_000 - i * 1000))
    }

    // One more assistant after final compaction.
    analyzer.processMessage(makeAssistantTextOnly({
      messageId: uniqueMsgId(),
      inputTokens: 5000,
      outputTokens: 1000,
    }))
    analyzer.processMessage(makeResultSuccess())

    const summary = analyzer.getSessionSummary()
    assert.equal(summary.compactions, numCompactions)
  })

  test('compaction events interleaved with tool calls', () => {
    const analyzer = createAnalyzer()
    analyzer.processMessage(makeSystemInit())

    analyzer.processMessage(makeAssistantWithToolUse({
      messageId: uniqueMsgId(),
      toolName: 'Read',
      toolId: 'toolu_pre_compact_1',
    }))
    analyzer.processMessage(makeUserMessage({ toolResultId: 'toolu_pre_compact_1' }))

    // Compaction.
    analyzer.processMessage(makeCompactBoundary())

    // More tool use after compaction.
    analyzer.processMessage(makeAssistantWithToolUse({
      messageId: uniqueMsgId(),
      toolName: 'Read',
      toolId: 'toolu_post_compact_1',
    }))
    analyzer.processMessage(makeUserMessage({ toolResultId: 'toolu_post_compact_1' }))
    analyzer.processMessage(makeResultSuccess())

    const summary = analyzer.getSessionSummary()
    assert.equal(summary.compactions, 1)
    assert.equal(summary.toolCallSummary['Read']?.count, 2)
  })
})

// ─── 6. Very long sessions with hundreds of events ───────────────────────────

describe('Edge: very long sessions', () => {
  test('handles 500 assistant messages without issues', () => {
    const analyzer = createAnalyzer()
    analyzer.processMessage(makeSystemInit({ model: 'claude-sonnet-4-5' }))

    const messageCount = 500
    for (let i = 0; i < messageCount; i++) {
      analyzer.processMessage(makeAssistantTextOnly({
        messageId: uniqueMsgId(),
        inputTokens: 100,
        outputTokens: 50,
        model: 'claude-sonnet-4-5',
      }))
    }

    analyzer.processMessage(makeResultSuccess({
      totalCostUsd: 1.23,
      numTurns: messageCount,
    }))

    const summary = analyzer.getSessionSummary()
    assert.equal(summary.numTurns, messageCount)
    assert.equal(summary.totalCostUsd, 1.23)

    // Computed usage should be sum of all assistant messages.
    const running = analyzer.getRunningCost()
    assert.equal(running.totalInputTokens, messageCount * 100)
    assert.equal(running.totalOutputTokens, messageCount * 50)
    assert.equal(running.messageCount, messageCount)
  })

  test('handles mix of 200 assistant + 200 user + 10 compactions', () => {
    const analyzer = createAnalyzer()
    analyzer.processMessage(makeSystemInit())

    for (let i = 0; i < 200; i++) {
      analyzer.processMessage(makeAssistantWithToolUse({
        messageId: uniqueMsgId(),
        toolName: i % 2 === 0 ? 'Read' : 'Bash',
        toolId: `toolu_long_${i}`,
        inputTokens: 200,
        outputTokens: 80,
      }))
      analyzer.processMessage(makeUserMessage({ toolResultId: `toolu_long_${i}` }))

      // Insert compaction every 20 turns.
      if ((i + 1) % 20 === 0) {
        analyzer.processMessage(makeCompactBoundary())
      }
    }

    analyzer.processMessage(makeResultSuccess({
      totalCostUsd: 5.0,
      numTurns: 200,
    }))

    const summary = analyzer.getSessionSummary()
    assert.equal(summary.compactions, 10)
    assert.equal(summary.toolCallSummary['Read']?.count, 100)
    assert.equal(summary.toolCallSummary['Bash']?.count, 100)
    // 1 init + 200 assistant + 200 user + 10 compactions + 1 result = 412
    assert.equal(analyzer.getEvents().length, 412)
  })
})

// ─── 7. Mixed model usage in a single session (main + sub-agent) ─────────────

describe('Edge: mixed model usage', () => {
  test('tracks cost for main agent (opus) and sub-agent (haiku) models', () => {
    const analyzer = createAnalyzer()
    analyzer.processMessage(makeSystemInit({ model: 'claude-opus-4-5' }))

    // Main agent message (opus).
    analyzer.processMessage(makeAssistantTextOnly({
      messageId: uniqueMsgId(),
      inputTokens: 1000,
      outputTokens: 500,
      model: 'claude-opus-4-5',
    }))

    // Sub-agent message (haiku) with parent_tool_use_id.
    analyzer.processMessage(makeAssistantTextOnly({
      messageId: uniqueMsgId(),
      inputTokens: 2000,
      outputTokens: 200,
      model: 'claude-haiku-4-5',
      parentToolUseId: 'toolu_subagent_spawn',
    }))

    // Another main agent message.
    analyzer.processMessage(makeAssistantTextOnly({
      messageId: uniqueMsgId(),
      inputTokens: 1000,
      outputTokens: 500,
      model: 'claude-opus-4-5',
    }))

    const running = analyzer.getRunningCost()
    assert.equal(running.totalInputTokens, 4000)
    assert.equal(running.totalOutputTokens, 1200)
    assert.equal(running.messageCount, 3)

    // Computed cost should reflect different pricing for different models.
    // opus-4-5: $5/MTok input, $25/MTok output
    // haiku-4-5: $1/MTok input, $5/MTok output
    const opusCost = (1000 / 1e6) * 5.0 + (500 / 1e6) * 25.0 // $0.005 + $0.0125 = $0.0175
    const haikuCost = (2000 / 1e6) * 1.0 + (200 / 1e6) * 5.0  // $0.002 + $0.001 = $0.003
    const expectedComputed = opusCost * 2 + haikuCost            // $0.035 + $0.003 = $0.038
    assert.ok(
      Math.abs(running.totalCostUsd - expectedComputed) < 1e-9,
      `expected computed cost ~${expectedComputed}, got ${running.totalCostUsd}`,
    )
  })

  test('result modelUsage with multiple models is extracted into summary', () => {
    const analyzer = createAnalyzer()
    analyzer.processMessage(makeSystemInit({ model: 'claude-opus-4-5' }))
    analyzer.processMessage(makeAssistantTextOnly({ messageId: uniqueMsgId() }))

    analyzer.processMessage(makeResultSuccess({
      totalCostUsd: 0.50,
      modelUsage: {
        'claude-opus-4-5': {
          inputTokens: 5000,
          outputTokens: 2000,
          cacheReadInputTokens: 1000,
          cacheCreationInputTokens: 500,
          webSearchRequests: 0,
          costUSD: 0.40,
          contextWindow: 200000,
        },
        'claude-haiku-4-5': {
          inputTokens: 3000,
          outputTokens: 1000,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          webSearchRequests: 2,
          costUSD: 0.10,
          contextWindow: 200000,
        },
      },
    }))

    const summary = analyzer.getSessionSummary()
    assert.equal(Object.keys(summary.modelUsage).length, 2)
    assert.equal(summary.modelUsage['claude-opus-4-5'].costUSD, 0.40)
    assert.equal(summary.modelUsage['claude-haiku-4-5'].costUSD, 0.10)
    assert.equal(summary.modelUsage['claude-haiku-4-5'].webSearchRequests, 2)
    assert.equal(summary.totalCostUsd, 0.50)
  })
})

// ─── 8. Sub-agent messages with parent_tool_use_id tracking ──────────────────

describe('Edge: sub-agent parent_tool_use_id tracking', () => {
  test('sub-agent messages have parentToolUseId set on AgentEvent', () => {
    const analyzer = createAnalyzer()
    analyzer.processMessage(makeSystemInit())

    // Main agent spawns a sub-agent tool.
    analyzer.processMessage(makeAssistantWithToolUse({
      messageId: uniqueMsgId(),
      toolName: 'Task',
      toolId: 'toolu_task_spawn',
    }))

    // Sub-agent produces its own assistant messages with parent_tool_use_id.
    analyzer.processMessage(makeAssistantTextOnly({
      messageId: uniqueMsgId(),
      parentToolUseId: 'toolu_task_spawn',
      model: 'claude-haiku-4-5',
    }))

    analyzer.processMessage(makeAssistantWithToolUse({
      messageId: uniqueMsgId(),
      toolName: 'Read',
      toolId: 'toolu_sub_read_1',
    }))

    const events = analyzer.getEvents()
    const subAgentEvent = events.find((e) => e.parentToolUseId === 'toolu_task_spawn')
    assert.ok(subAgentEvent, 'should find a sub-agent event')
    assert.equal(subAgentEvent.parentToolUseId, 'toolu_task_spawn')
    assert.equal(subAgentEvent.model, 'claude-haiku-4-5')
  })

  test('sub-agent tool calls are aggregated with main agent tool calls', () => {
    const analyzer = createAnalyzer()
    analyzer.processMessage(makeSystemInit())

    // Main agent uses Read.
    analyzer.processMessage(makeAssistantWithToolUse({
      messageId: uniqueMsgId(),
      toolName: 'Read',
      toolId: 'toolu_main_read',
    }))

    // Sub-agent also uses Read (with parent_tool_use_id linking to a Task tool).
    const subMsg = makeAssistantWithToolUse({
      messageId: uniqueMsgId(),
      toolName: 'Read',
      toolId: 'toolu_sub_read',
    })
    // Manually set parent_tool_use_id on the raw message.
    ;(subMsg as Record<string, unknown>)['parent_tool_use_id'] = 'toolu_task_spawn'
    analyzer.processMessage(subMsg)

    const agg = analyzer.getToolAggregator()
    assert.equal(agg.get('Read')?.count, 2, 'both main and sub-agent Read calls are counted')
    assert.deepEqual(agg.get('Read')?.toolIds, ['toolu_main_read', 'toolu_sub_read'])
  })

  test('multiple sub-agents with different parent_tool_use_ids', () => {
    const analyzer = createAnalyzer()
    analyzer.processMessage(makeSystemInit())

    // Main agent spawns sub-agent A.
    analyzer.processMessage(makeAssistantWithToolUse({
      messageId: uniqueMsgId(),
      toolName: 'Task',
      toolId: 'toolu_subA',
    }))

    // Sub-agent A works.
    analyzer.processMessage(makeAssistantTextOnly({
      messageId: uniqueMsgId(),
      parentToolUseId: 'toolu_subA',
    }))

    // Main agent spawns sub-agent B.
    analyzer.processMessage(makeAssistantWithToolUse({
      messageId: uniqueMsgId(),
      toolName: 'Task',
      toolId: 'toolu_subB',
    }))

    // Sub-agent B works.
    analyzer.processMessage(makeAssistantTextOnly({
      messageId: uniqueMsgId(),
      parentToolUseId: 'toolu_subB',
    }))

    const events = analyzer.getEvents()
    const subAEvents = events.filter((e) => e.parentToolUseId === 'toolu_subA')
    const subBEvents = events.filter((e) => e.parentToolUseId === 'toolu_subB')
    assert.equal(subAEvents.length, 1)
    assert.equal(subBEvents.length, 1)
  })
})

// ─── 9. getSessionSummary() at different processing points ───────────────────

describe('Edge: getSessionSummary at different points', () => {
  test('summary before any events', () => {
    const analyzer = createAnalyzer()
    const s = analyzer.getSessionSummary()
    assert.equal(s.status, 'incomplete')
    assert.equal(s.sessionId, '')
  })

  test('summary after init only', () => {
    const analyzer = createAnalyzer()
    analyzer.processMessage(makeSystemInit())
    const s = analyzer.getSessionSummary()
    assert.equal(s.status, 'incomplete')
    assert.equal(s.sessionId, 'sess-1')
    assert.equal(s.numTurns, 0)
  })

  test('summary mid-session (after some assistant messages, before result)', () => {
    const analyzer = createAnalyzer()
    analyzer.processMessage(makeSystemInit())
    analyzer.processMessage(makeAssistantTextOnly({
      messageId: uniqueMsgId(),
      inputTokens: 1000,
      outputTokens: 200,
    }))
    analyzer.processMessage(makeAssistantWithToolUse({
      messageId: uniqueMsgId(),
      toolName: 'Bash',
      toolId: 'toolu_mid_1',
    }))

    const s = analyzer.getSessionSummary()
    assert.equal(s.status, 'incomplete')
    // numTurns should be computed from assistant events since no result message yet.
    assert.equal(s.numTurns, 2)
    // Computed cost should equal total since no authoritative cost exists.
    assert.equal(s.totalCostUsd, s.computedCostUsd)
    assert.ok(s.computedCostUsd > 0)
    assert.ok(s.toolCallSummary['Bash'])
  })

  test('summary after result shows authoritative data', () => {
    const analyzer = createAnalyzer()
    analyzer.processMessage(makeSystemInit())
    analyzer.processMessage(makeAssistantTextOnly({ messageId: uniqueMsgId() }))
    analyzer.processMessage(makeResultSuccess({
      totalCostUsd: 0.123,
      numTurns: 5,
      durationMs: 30000,
      durationApiMs: 25000,
    }))

    const s = analyzer.getSessionSummary()
    assert.equal(s.status, 'success')
    assert.equal(s.totalCostUsd, 0.123)
    assert.equal(s.numTurns, 5)
    assert.equal(s.durationMs, 30000)
    assert.equal(s.durationApiMs, 25000)
  })

  test('summary is a fresh snapshot each call (not a cached reference)', () => {
    const analyzer = createAnalyzer()
    analyzer.processMessage(makeSystemInit())

    const s1 = analyzer.getSessionSummary()
    analyzer.processMessage(makeAssistantTextOnly({ messageId: uniqueMsgId() }))
    const s2 = analyzer.getSessionSummary()

    // s1 should not have been mutated by the second processMessage.
    assert.equal(s1.numTurns, 0)
    assert.equal(s2.numTurns, 1)
  })
})

// ─── 10. StreamEvent processing with interleaved error events ────────────────

describe('Edge: StreamEvent with errors and done', () => {
  test('error StreamEvents are skipped, valid events still processed', () => {
    const analyzer = createAnalyzer()

    const events: StreamEvent[] = [
      wrapAsStreamEvent(makeSystemInit(), 'run-1', 0),
      { type: 'error', runId: 'run-1', text: 'transient network error' },
      wrapAsStreamEvent(makeAssistantTextOnly({ messageId: uniqueMsgId() }), 'run-1', 1),
      { type: 'error', runId: 'run-1', text: 'another transient error' },
      wrapAsStreamEvent(makeResultSuccess(), 'run-1', 2),
    ]

    const results = events.map((ev) => analyzer.processStreamEvent(ev))
    // Error events return null.
    assert.equal(results[1], null)
    assert.equal(results[3], null)
    // Valid events return AnalyzeResult.
    assert.ok(results[0])
    assert.ok(results[2])
    assert.ok(results[4])

    const summary = analyzer.getSessionSummary()
    assert.equal(summary.status, 'success')
  })

  test('done StreamEvent returns null', () => {
    const analyzer = createAnalyzer()
    const done: StreamEvent = { type: 'done', runId: 'run-1', exitCode: 0, logPath: '/tmp/log' }
    assert.equal(analyzer.processStreamEvent(done), null)
  })

  test('done with non-zero exit code still returns null', () => {
    const analyzer = createAnalyzer()
    const done: StreamEvent = { type: 'done', runId: 'run-1', exitCode: 1, logPath: '/tmp/log' }
    assert.equal(analyzer.processStreamEvent(done), null)
  })

  test('stream of only error events produces empty summary', () => {
    const analyzer = createAnalyzer()
    for (let i = 0; i < 5; i++) {
      analyzer.processStreamEvent({ type: 'error', runId: 'run-1', text: `error ${i}` })
    }
    const summary = analyzer.getSessionSummary()
    assert.equal(summary.sessionId, '')
    assert.equal(summary.status, 'incomplete')
    assert.equal(analyzer.getEvents().length, 0)
  })
})

// ─── 11. Cost discrepancy between computed and authoritative cost ─────────────

describe('Edge: cost discrepancy', () => {
  test('authoritative cost differs significantly from computed cost', () => {
    const analyzer = createAnalyzer()
    analyzer.processMessage(makeSystemInit({ model: 'claude-sonnet-4-5' }))

    // Process messages that will accumulate computed cost.
    analyzer.processMessage(makeAssistantTextOnly({
      messageId: uniqueMsgId(),
      inputTokens: 100_000,
      outputTokens: 10_000,
      model: 'claude-sonnet-4-5',
    }))

    // Authoritative cost is much higher (perhaps includes sub-agent costs).
    analyzer.processMessage(makeResultSuccess({
      totalCostUsd: 10.00,
    }))

    const summary = analyzer.getSessionSummary()
    assert.equal(summary.totalCostUsd, 10.00, 'authoritative cost should be used')
    assert.ok(summary.computedCostUsd < 10.00, 'computed cost should be lower')
    assert.ok(summary.computedCostUsd > 0, 'computed cost should be non-zero')
    // The discrepancy is available for consumers to inspect.
    assert.notEqual(summary.totalCostUsd, summary.computedCostUsd)
  })

  test('authoritative cost is zero but computed is non-zero', () => {
    const analyzer = createAnalyzer()
    analyzer.processMessage(makeSystemInit({ model: 'claude-sonnet-4-5' }))
    analyzer.processMessage(makeAssistantTextOnly({
      messageId: uniqueMsgId(),
      inputTokens: 50_000,
      outputTokens: 5000,
      model: 'claude-sonnet-4-5',
    }))

    analyzer.processMessage(makeResultSuccess({ totalCostUsd: 0 }))

    const summary = analyzer.getSessionSummary()
    assert.equal(summary.totalCostUsd, 0)
    assert.ok(summary.computedCostUsd > 0)
  })
})

// ─── 12. Session where all messages have null usage ──────────────────────────

describe('Edge: all null usage', () => {
  test('assistant messages with no usage field', () => {
    const analyzer = createAnalyzer()
    analyzer.processMessage(makeSystemInit())

    // Create an assistant message with no usage at all.
    const noUsageMsg = {
      type: 'assistant',
      uuid: 'uuid-no-usage',
      session_id: 'sess-1',
      parent_tool_use_id: null,
      message: {
        id: uniqueMsgId(),
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello' }],
        model: 'claude-sonnet-4-5',
        stop_reason: 'end_turn',
        // No usage field at all.
      },
    } as unknown as SDKMessage

    const r = analyzer.processMessage(noUsageMsg)
    assert.ok(r.event)
    assert.equal(r.event.usage, null)
    assert.equal(r.runningCost.totalCostUsd, 0)
    assert.equal(r.runningCost.messageCount, 0)
  })

  test('session of system + multiple no-usage assistants results in zero cost', () => {
    const analyzer = createAnalyzer()
    analyzer.processMessage(makeSystemInit())

    for (let i = 0; i < 10; i++) {
      const msg = {
        type: 'assistant',
        uuid: `uuid-nu-${i}`,
        session_id: 'sess-1',
        parent_tool_use_id: null,
        message: {
          id: uniqueMsgId(),
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: `message ${i}` }],
          model: 'claude-sonnet-4-5',
          stop_reason: 'end_turn',
        },
      } as unknown as SDKMessage
      analyzer.processMessage(msg)
    }

    const summary = analyzer.getSessionSummary()
    assert.equal(summary.computedCostUsd, 0)
    assert.equal(summary.tokenUsage.inputTokens, 0)
    assert.equal(summary.tokenUsage.outputTokens, 0)
    // But numTurns should still be counted.
    assert.equal(summary.numTurns, 10)
  })
})

// ─── 13. Analyzer reuse across multiple sessions with reset() ────────────────

describe('Edge: analyzer reuse with reset()', () => {
  test('reset clears everything including deduplication state', () => {
    const analyzer = createAnalyzer()
    analyzer.processMessage(makeSystemInit())
    analyzer.processMessage(makeAssistantTextOnly({ messageId: 'reuse-msg-1' }))
    analyzer.processMessage(makeResultSuccess())

    analyzer.reset()

    // After reset, the same message ID should be accepted again.
    const r = analyzer.processMessage(makeAssistantTextOnly({ messageId: 'reuse-msg-1' }))
    assert.ok(r.event, 'same messageId should be accepted after reset')
    assert.equal(analyzer.getEvents().length, 1)
  })

  test('multiple sessions processed sequentially with reset between', () => {
    const analyzer = createAnalyzer()

    // Session 1.
    analyzer.processMessage(makeSystemInit({ session_id: 'sess-A', model: 'claude-opus-4-5' }))
    analyzer.processMessage(makeAssistantTextOnly({
      messageId: 'sess-A-msg-1',
      sessionId: 'sess-A',
      inputTokens: 5000,
      outputTokens: 1000,
      model: 'claude-opus-4-5',
    }))
    analyzer.processMessage(makeResultSuccess({ sessionId: 'sess-A', totalCostUsd: 0.50 }))

    const s1 = analyzer.getSessionSummary()
    assert.equal(s1.sessionId, 'sess-A')
    assert.equal(s1.totalCostUsd, 0.50)

    analyzer.reset()

    // Session 2 with a different model.
    analyzer.processMessage(makeSystemInit({ session_id: 'sess-B', model: 'claude-haiku-4-5' }))
    analyzer.processMessage(makeAssistantTextOnly({
      messageId: 'sess-B-msg-1',
      sessionId: 'sess-B',
      inputTokens: 10_000,
      outputTokens: 2000,
      model: 'claude-haiku-4-5',
    }))
    analyzer.processMessage(makeResultSuccess({ sessionId: 'sess-B', totalCostUsd: 0.02 }))

    const s2 = analyzer.getSessionSummary()
    assert.equal(s2.sessionId, 'sess-B')
    assert.equal(s2.totalCostUsd, 0.02)
    // Session 1 data should be completely gone.
    assert.notEqual(s2.computedCostUsd, s1.computedCostUsd)
  })

  test('reset followed by getSessionSummary returns clean state', () => {
    const analyzer = createAnalyzer()
    analyzer.processMessage(makeSystemInit())
    analyzer.processMessage(makeAssistantTextOnly({ messageId: uniqueMsgId() }))
    analyzer.processMessage(makeResultSuccess({ totalCostUsd: 1.0 }))

    analyzer.reset()

    const s = analyzer.getSessionSummary()
    assert.equal(s.status, 'incomplete')
    assert.equal(s.totalCostUsd, 0)
    assert.equal(s.computedCostUsd, 0)
    assert.equal(s.sessionId, '')
    assert.deepEqual(s.toolCallSummary, {})
  })

  test('three consecutive sessions on same analyzer instance', () => {
    const analyzer = createAnalyzer()

    for (let session = 1; session <= 3; session++) {
      analyzer.processMessage(makeSystemInit({ session_id: `sess-${session}` }))
      analyzer.processMessage(makeAssistantWithToolUse({
        messageId: `s${session}-msg`,
        toolName: 'Bash',
        toolId: `s${session}-tool`,
        sessionId: `sess-${session}`,
      }))
      analyzer.processMessage(makeResultSuccess({
        totalCostUsd: session * 0.01,
        sessionId: `sess-${session}`,
      }))

      const s = analyzer.getSessionSummary()
      assert.equal(s.sessionId, `sess-${session}`)
      assert.equal(s.totalCostUsd, session * 0.01)
      assert.equal(s.toolCallSummary['Bash']?.count, 1)

      analyzer.reset()
    }

    // After final reset, clean state.
    assert.equal(analyzer.getEvents().length, 0)
  })
})

// ─── 14. Result message with empty modelUsage ────────────────────────────────

describe('Edge: result with empty modelUsage', () => {
  test('empty modelUsage object in result', () => {
    const analyzer = createAnalyzer()
    analyzer.processMessage(makeSystemInit())
    analyzer.processMessage(makeAssistantTextOnly({ messageId: uniqueMsgId() }))

    analyzer.processMessage(makeResultSuccess({ modelUsage: {} }))

    const summary = analyzer.getSessionSummary()
    assert.deepEqual(summary.modelUsage, {})
    // totalCostUsd still comes from the authoritative field.
    assert.equal(summary.totalCostUsd, 0.0234)
  })

  test('missing modelUsage field entirely', () => {
    const analyzer = createAnalyzer()
    analyzer.processMessage(makeSystemInit())

    // Construct a result message without modelUsage at all.
    const resultNoModelUsage = {
      type: 'result',
      subtype: 'success',
      uuid: 'uuid-result-no-mu',
      session_id: 'sess-1',
      duration_ms: 5000,
      duration_api_ms: 4000,
      is_error: false,
      num_turns: 1,
      total_cost_usd: 0.01,
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      // No modelUsage field.
      permission_denials: [],
    } as unknown as SDKMessage

    analyzer.processMessage(resultNoModelUsage)

    const summary = analyzer.getSessionSummary()
    assert.deepEqual(summary.modelUsage, {})
    assert.equal(summary.totalCostUsd, 0.01)
  })
})

// ─── 15. Result message with multiple models in modelUsage ───────────────────

describe('Edge: result with multiple models in modelUsage', () => {
  test('three models in modelUsage (main + 2 sub-agents)', () => {
    const analyzer = createAnalyzer()
    analyzer.processMessage(makeSystemInit({ model: 'claude-opus-4-5' }))
    analyzer.processMessage(makeAssistantTextOnly({ messageId: uniqueMsgId() }))

    analyzer.processMessage(makeResultSuccess({
      totalCostUsd: 2.50,
      modelUsage: {
        'claude-opus-4-5': {
          inputTokens: 10000,
          outputTokens: 5000,
          cacheReadInputTokens: 2000,
          cacheCreationInputTokens: 1000,
          webSearchRequests: 0,
          costUSD: 2.00,
          contextWindow: 200000,
        },
        'claude-sonnet-4-5': {
          inputTokens: 5000,
          outputTokens: 2000,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          webSearchRequests: 0,
          costUSD: 0.30,
          contextWindow: 200000,
        },
        'claude-haiku-4-5': {
          inputTokens: 8000,
          outputTokens: 3000,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          webSearchRequests: 3,
          costUSD: 0.20,
          contextWindow: 200000,
        },
      },
    }))

    const summary = analyzer.getSessionSummary()
    assert.equal(Object.keys(summary.modelUsage).length, 3)
    assert.equal(summary.modelUsage['claude-opus-4-5'].costUSD, 2.00)
    assert.equal(summary.modelUsage['claude-sonnet-4-5'].costUSD, 0.30)
    assert.equal(summary.modelUsage['claude-haiku-4-5'].costUSD, 0.20)
    assert.equal(summary.modelUsage['claude-haiku-4-5'].webSearchRequests, 3)
    assert.equal(summary.totalCostUsd, 2.50)
  })

  test('modelUsage entries with zero values', () => {
    const analyzer = createAnalyzer()
    analyzer.processMessage(makeSystemInit())
    analyzer.processMessage(makeAssistantTextOnly({ messageId: uniqueMsgId() }))

    analyzer.processMessage(makeResultSuccess({
      totalCostUsd: 0.0,
      modelUsage: {
        'claude-sonnet-4-5': {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          webSearchRequests: 0,
          costUSD: 0,
          contextWindow: 200000,
        },
      },
    }))

    const summary = analyzer.getSessionSummary()
    assert.equal(summary.modelUsage['claude-sonnet-4-5'].costUSD, 0)
    assert.equal(summary.modelUsage['claude-sonnet-4-5'].inputTokens, 0)
  })
})

// ─── 16. Tool aggregation across dozens of different tool types ──────────────

describe('Edge: tool aggregation across many tools', () => {
  test('aggregates 30 different tool types correctly', () => {
    const analyzer = createAnalyzer()
    analyzer.processMessage(makeSystemInit())

    const toolNames = [
      'Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'WebFetch',
      'WebSearch', 'NotebookEdit', 'TodoWrite', 'Task', 'Skill',
      'mcp__github__create_issue', 'mcp__github__list_prs',
      'mcp__slack__send_message', 'mcp__jira__create_ticket',
      'mcp__db__query', 'mcp__s3__upload', 'mcp__docker__run',
      'mcp__k8s__get_pods', 'mcp__terraform__plan', 'mcp__ci__trigger',
      'custom_tool_1', 'custom_tool_2', 'custom_tool_3', 'custom_tool_4',
      'custom_tool_5', 'custom_tool_6', 'custom_tool_7', 'custom_tool_8',
    ]

    for (let i = 0; i < toolNames.length; i++) {
      analyzer.processMessage(makeAssistantWithToolUse({
        messageId: uniqueMsgId(),
        toolName: toolNames[i],
        toolId: `toolu_variety_${i}`,
      }))
    }

    const agg = analyzer.getToolAggregator()
    assert.equal(agg.getTotalCount(), 30)
    assert.equal(agg.getToolNames().length, 30)

    for (const name of toolNames) {
      const summary = agg.get(name)
      assert.ok(summary, `tool ${name} should be tracked`)
      assert.equal(summary.count, 1)
    }
  })

  test('same tool used many times accumulates correctly', () => {
    const analyzer = createAnalyzer()
    analyzer.processMessage(makeSystemInit())

    const callCount = 50
    for (let i = 0; i < callCount; i++) {
      analyzer.processMessage(makeAssistantWithToolUse({
        messageId: uniqueMsgId(),
        toolName: 'Read',
        toolId: `toolu_repeated_${i}`,
      }))
    }

    const agg = analyzer.getToolAggregator()
    assert.equal(agg.get('Read')?.count, callCount)
    assert.equal(agg.get('Read')?.toolIds.length, callCount)
    assert.equal(agg.getTotalCount(), callCount)
    assert.equal(agg.getToolNames().length, 1)
  })

  test('multi-tool messages accumulate each tool separately', () => {
    const analyzer = createAnalyzer()
    analyzer.processMessage(makeSystemInit())

    // Each message has 2 tools.
    for (let i = 0; i < 10; i++) {
      analyzer.processMessage(makeAssistantMultiTool({
        messageId: uniqueMsgId(),
        tools: [
          { name: 'Read', id: `toolu_r_${i}`, input: {} },
          { name: 'Bash', id: `toolu_b_${i}`, input: {} },
        ],
      }))
    }

    const agg = analyzer.getToolAggregator()
    assert.equal(agg.get('Read')?.count, 10)
    assert.equal(agg.get('Bash')?.count, 10)
    assert.equal(agg.getTotalCount(), 20)
  })
})

// ─── 17. Processing the same session twice without reset ─────────────────────

describe('Edge: double processing without reset', () => {
  test('processing same messages twice causes double counting in running cost', () => {
    const analyzer = createAnalyzer()

    const initMsg = makeSystemInit({ model: 'claude-sonnet-4-5' })
    const assistMsg = makeAssistantTextOnly({
      messageId: 'double-msg-1',
      inputTokens: 1000,
      outputTokens: 500,
      model: 'claude-sonnet-4-5',
    })
    const resultMsg = makeResultSuccess({ totalCostUsd: 0.10 })

    // Process session once.
    analyzer.processMessage(initMsg)
    analyzer.processMessage(assistMsg)
    analyzer.processMessage(resultMsg)

    const cost1 = analyzer.getRunningCost()
    const events1 = analyzer.getEvents().length

    // Process same session again (simulate mistake — no reset).
    analyzer.processMessage(initMsg)
    // The assistant message will be deduplicated by messageId!
    const r2 = analyzer.processMessage(assistMsg)
    analyzer.processMessage(resultMsg)

    // The dedup prevents the assistant message from being double-counted.
    assert.equal(r2.event, null, 'duplicate messageId should be skipped')

    // But system and result events are not deduped — they get added again.
    const events2 = analyzer.getEvents().length
    assert.ok(events2 > events1, 'system and result events are added again')

    // Running cost remains the same for assistant messages (deduped) but
    // the result event's costUsd is tracked separately.
    const cost2 = analyzer.getRunningCost()
    assert.equal(
      cost2.totalInputTokens,
      cost1.totalInputTokens,
      'assistant usage should not be double counted due to dedup',
    )
  })

  test('tool calls are not double-counted due to assistant message dedup', () => {
    const analyzer = createAnalyzer()
    analyzer.processMessage(makeSystemInit())

    const toolMsg = makeAssistantWithToolUse({
      messageId: 'double-tool-1',
      toolName: 'Read',
      toolId: 'toolu_double',
    })

    analyzer.processMessage(toolMsg)
    analyzer.processMessage(toolMsg) // Second time — same messageId.

    const agg = analyzer.getToolAggregator()
    assert.equal(agg.get('Read')?.count, 1, 'tool call should not be double counted')
  })

  test('different messageIds without reset causes genuine double counting', () => {
    const analyzer = createAnalyzer()
    analyzer.processMessage(makeSystemInit({ model: 'claude-sonnet-4-5' }))

    // First pass.
    analyzer.processMessage(makeAssistantTextOnly({
      messageId: 'first-pass-msg',
      inputTokens: 1000,
      outputTokens: 500,
      model: 'claude-sonnet-4-5',
    }))

    const cost1 = analyzer.getRunningCost()

    // Second pass with different messageId (simulating the messages being re-emitted
    // with new IDs, e.g., during session replay).
    analyzer.processMessage(makeAssistantTextOnly({
      messageId: 'second-pass-msg',
      inputTokens: 1000,
      outputTokens: 500,
      model: 'claude-sonnet-4-5',
    }))

    const cost2 = analyzer.getRunningCost()
    assert.equal(cost2.totalInputTokens, cost1.totalInputTokens * 2)
    assert.equal(cost2.totalOutputTokens, cost1.totalOutputTokens * 2)
    assert.equal(cost2.messageCount, 2)
  })
})

// ─── 18. Additional edge cases ───────────────────────────────────────────────

describe('Edge: unknown and unhandled message types', () => {
  test('unknown message type returns null event', () => {
    const analyzer = createAnalyzer()
    const unknown = {
      type: 'hook_started',
      session_id: 'sess-1',
      uuid: 'uuid-hook',
    } as unknown as SDKMessage

    const r = analyzer.processMessage(unknown)
    assert.equal(r.event, null)
    assert.equal(r.isResult, false)
  })

  test('message with no type field returns null event', () => {
    const analyzer = createAnalyzer()
    const noType = { session_id: 'sess-1' } as unknown as SDKMessage

    const r = analyzer.processMessage(noType)
    assert.equal(r.event, null)
  })

  test('system message with unknown subtype is ignored', () => {
    const analyzer = createAnalyzer()
    const unknownSub = {
      type: 'system',
      subtype: 'unknown_subtype',
      uuid: 'uuid-sys-unknown',
      session_id: 'sess-1',
    } as unknown as SDKMessage

    const r = analyzer.processMessage(unknownSub)
    assert.equal(r.event, null)
  })
})

describe('Edge: stream_event (partial messages) are skipped', () => {
  test('SDK stream_event type is skipped', () => {
    const analyzer = createAnalyzer()
    const r = analyzer.processMessage(makeStreamEvent())
    assert.equal(r.event, null)
    assert.equal(analyzer.getEvents().length, 0)
  })

  test('many stream events followed by a real assistant message', () => {
    const analyzer = createAnalyzer()
    analyzer.processMessage(makeSystemInit())

    // Simulate many streaming partial deltas before the full assistant message.
    for (let i = 0; i < 20; i++) {
      const r = analyzer.processMessage(makeStreamEvent())
      assert.equal(r.event, null)
    }

    // The real assistant message.
    const r = analyzer.processMessage(makeAssistantTextOnly({ messageId: uniqueMsgId() }))
    assert.ok(r.event)
    // Only init + 1 assistant = 2.
    assert.equal(analyzer.getEvents().length, 2)
  })
})

describe('Edge: assistant message with no inner message', () => {
  test('assistant type with missing message object returns null event', () => {
    const analyzer = createAnalyzer()
    const noInner = {
      type: 'assistant',
      uuid: 'uuid-no-inner',
      session_id: 'sess-1',
      parent_tool_use_id: null,
      // No message property.
    } as unknown as SDKMessage

    const r = analyzer.processMessage(noInner)
    assert.equal(r.event, null)
  })
})

describe('Edge: result message subtypes', () => {
  test('error_max_budget_usd subtype', () => {
    const analyzer = createAnalyzer()
    analyzer.processMessage(makeSystemInit())
    analyzer.processMessage(makeResultError({
      subtype: 'error_max_budget_usd',
      errors: ['Budget limit of $1.00 exceeded'],
    }))

    const s = analyzer.getSessionSummary()
    assert.equal(s.status, 'error_max_budget_usd')
    assert.deepEqual(s.errors, ['Budget limit of $1.00 exceeded'])
  })

  test('error_during_execution subtype', () => {
    const analyzer = createAnalyzer()
    analyzer.processMessage(makeSystemInit())
    analyzer.processMessage(makeResultError({
      subtype: 'error_during_execution',
      errors: ['Unexpected tool failure'],
    }))

    const s = analyzer.getSessionSummary()
    assert.equal(s.status, 'error_during_execution')
  })

  test('error_max_turns subtype', () => {
    const analyzer = createAnalyzer()
    analyzer.processMessage(makeSystemInit())
    analyzer.processMessage(makeResultError({
      subtype: 'error_max_turns',
      numTurns: 50,
      errors: ['Maximum number of turns (50) exceeded'],
    }))

    const s = analyzer.getSessionSummary()
    assert.equal(s.status, 'error_max_turns')
    assert.equal(s.numTurns, 50)
  })
})

describe('Edge: cache token cost calculation', () => {
  test('high cache creation tokens are costed correctly', () => {
    const analyzer = createAnalyzer()
    analyzer.processMessage(makeSystemInit({ model: 'claude-sonnet-4-5' }))

    analyzer.processMessage(makeAssistantTextOnly({
      messageId: uniqueMsgId(),
      inputTokens: 0,
      outputTokens: 0,
      cacheCreation: 1_000_000,
      cacheRead: 0,
      model: 'claude-sonnet-4-5',
    }))

    const running = analyzer.getRunningCost()
    // sonnet-4-5 cacheWrite5mPerMTok = 3.75
    assert.equal(running.totalCacheCreationTokens, 1_000_000)
    assert.equal(running.totalCostUsd, 3.75)
  })

  test('high cache read tokens are costed correctly', () => {
    const analyzer = createAnalyzer()
    analyzer.processMessage(makeSystemInit({ model: 'claude-sonnet-4-5' }))

    analyzer.processMessage(makeAssistantTextOnly({
      messageId: uniqueMsgId(),
      inputTokens: 0,
      outputTokens: 0,
      cacheCreation: 0,
      cacheRead: 1_000_000,
      model: 'claude-sonnet-4-5',
    }))

    const running = analyzer.getRunningCost()
    // sonnet-4-5 cacheReadPerMTok = 0.30
    assert.equal(running.totalCacheReadTokens, 1_000_000)
    assert.equal(running.totalCostUsd, 0.30)
  })
})

describe('Edge: unknown model yields zero computed cost', () => {
  test('messages with unknown model name produce zero cost', () => {
    const analyzer = createAnalyzer()
    analyzer.processMessage(makeSystemInit({ model: 'gpt-4o-unknown' }))

    analyzer.processMessage(makeAssistantTextOnly({
      messageId: uniqueMsgId(),
      inputTokens: 100_000,
      outputTokens: 50_000,
      model: 'gpt-4o-unknown',
    }))

    const running = analyzer.getRunningCost()
    assert.equal(running.totalCostUsd, 0, 'unknown model should produce zero cost')
    assert.equal(running.totalInputTokens, 100_000, 'tokens should still be tracked')
    assert.equal(running.totalOutputTokens, 50_000)
    assert.equal(running.messageCount, 1)
  })

  test('null model on assistant message produces zero cost', () => {
    const analyzer = createAnalyzer()
    // No model set anywhere.
    const msg = {
      type: 'assistant',
      uuid: 'uuid-null-model',
      session_id: 'sess-1',
      parent_tool_use_id: null,
      message: {
        id: uniqueMsgId(),
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello' }],
        // No model field.
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 500,
          output_tokens: 200,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    } as unknown as SDKMessage

    const r = analyzer.processMessage(msg)
    assert.ok(r.event)
    assert.equal(r.event.costUsd, 0)
    assert.equal(r.runningCost.totalCostUsd, 0)
    // But tokens are still tracked.
    assert.equal(r.runningCost.totalInputTokens, 500)
  })
})

describe('Edge: getEvents returns a defensive copy', () => {
  test('mutating getEvents() result does not affect analyzer state', () => {
    const analyzer = createAnalyzer()
    analyzer.processMessage(makeSystemInit())
    analyzer.processMessage(makeAssistantTextOnly({ messageId: uniqueMsgId() }))

    const events = analyzer.getEvents()
    events.length = 0 // Mutate the returned array.

    // Internal state should be unaffected.
    assert.equal(analyzer.getEvents().length, 2)
  })
})

describe('Edge: getRunningCost returns a snapshot', () => {
  test('returned RunningCost is not a reference to internal state', () => {
    const analyzer = createAnalyzer()
    analyzer.processMessage(makeSystemInit({ model: 'claude-sonnet-4-5' }))
    analyzer.processMessage(makeAssistantTextOnly({
      messageId: uniqueMsgId(),
      inputTokens: 100,
      outputTokens: 50,
      model: 'claude-sonnet-4-5',
    }))

    const snapshot = analyzer.getRunningCost()
    const costBefore = snapshot.totalCostUsd

    // Process more messages.
    analyzer.processMessage(makeAssistantTextOnly({
      messageId: uniqueMsgId(),
      inputTokens: 100,
      outputTokens: 50,
      model: 'claude-sonnet-4-5',
    }))

    // The snapshot should not have changed.
    assert.equal(snapshot.totalCostUsd, costBefore)
    // But a new call should reflect the new state.
    assert.ok(analyzer.getRunningCost().totalCostUsd > costBefore)
  })
})

describe('Edge: result with authoritative usage overrides computed', () => {
  test('result usage is used for tokenUsage instead of computed aggregation', () => {
    const analyzer = createAnalyzer()
    analyzer.processMessage(makeSystemInit())

    // Computed: 1000 input, 500 output.
    analyzer.processMessage(makeAssistantTextOnly({
      messageId: uniqueMsgId(),
      inputTokens: 1000,
      outputTokens: 500,
    }))

    // Authoritative: different numbers (includes sub-agent totals).
    analyzer.processMessage(makeResultSuccess({
      inputTokens: 5000,
      outputTokens: 2000,
      cacheCreation: 1000,
      cacheRead: 3000,
    }))

    const summary = analyzer.getSessionSummary()
    // tokenUsage should reflect the authoritative result, not computed.
    assert.equal(summary.tokenUsage.inputTokens, 5000)
    assert.equal(summary.tokenUsage.outputTokens, 2000)
    assert.equal(summary.tokenUsage.cacheCreationInputTokens, 1000)
    assert.equal(summary.tokenUsage.cacheReadInputTokens, 3000)
  })

  test('when result has no usage field, computed usage is used', () => {
    const analyzer = createAnalyzer()
    analyzer.processMessage(makeSystemInit())
    analyzer.processMessage(makeAssistantTextOnly({
      messageId: uniqueMsgId(),
      inputTokens: 1000,
      outputTokens: 500,
    }))

    // Result without usage field.
    const resultNoUsage = {
      type: 'result',
      subtype: 'success',
      uuid: 'uuid-result-no-usage',
      session_id: 'sess-1',
      duration_ms: 5000,
      duration_api_ms: 4000,
      num_turns: 1,
      total_cost_usd: 0.01,
      // No usage field.
      modelUsage: {},
      permission_denials: [],
    } as unknown as SDKMessage

    analyzer.processMessage(resultNoUsage)

    const summary = analyzer.getSessionSummary()
    // Falls back to computed usage.
    assert.equal(summary.tokenUsage.inputTokens, 1000)
    assert.equal(summary.tokenUsage.outputTokens, 500)
  })
})

describe('Edge: permission denials counting', () => {
  test('result with many permission denials', () => {
    const analyzer = createAnalyzer()
    analyzer.processMessage(makeSystemInit())

    const denials = Array.from({ length: 15 }, (_, i) => ({
      tool_name: `Tool_${i}`,
      tool_use_id: `toolu_denied_${i}`,
      tool_input: {},
    }))

    analyzer.processMessage(makeResultSuccess({ permissionDenials: denials }))

    const summary = analyzer.getSessionSummary()
    assert.equal(summary.permissionDenials, 15)
  })

  test('result with non-array permission_denials field', () => {
    const analyzer = createAnalyzer()
    analyzer.processMessage(makeSystemInit())

    const result = {
      type: 'result',
      subtype: 'success',
      uuid: 'uuid-result-bad-pd',
      session_id: 'sess-1',
      duration_ms: 1000,
      duration_api_ms: 800,
      num_turns: 1,
      total_cost_usd: 0.01,
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      modelUsage: {},
      permission_denials: 'not-an-array',
    } as unknown as SDKMessage

    analyzer.processMessage(result)

    const summary = analyzer.getSessionSummary()
    assert.equal(summary.permissionDenials, 0, 'non-array should yield 0')
  })
})

describe('Edge: realistic multi-turn agent session simulation', () => {
  test('full realistic session: init, multi-turn tool use, compaction, sub-agent, result', () => {
    const analyzer = createAnalyzer()

    // 1. System init.
    analyzer.processMessage(makeSystemInit({
      model: 'claude-sonnet-4-5-20250929',
      session_id: 'sess-real',
    }))

    // 2. First turn: assistant reads a file.
    analyzer.processMessage(makeAssistantWithToolUse({
      messageId: uniqueMsgId(),
      toolName: 'Read',
      toolId: 'toolu_real_1',
      inputTokens: 5000,
      outputTokens: 200,
      sessionId: 'sess-real',
    }))

    // 3. Tool result.
    analyzer.processMessage(makeUserMessage({
      toolResultId: 'toolu_real_1',
      content: 'file contents...',
      sessionId: 'sess-real',
    }))

    // 4. Second turn: assistant uses multi-tool (Read + Bash).
    analyzer.processMessage(makeAssistantMultiTool({
      messageId: uniqueMsgId(),
      inputTokens: 8000,
      outputTokens: 500,
      tools: [
        { name: 'Read', id: 'toolu_real_2', input: { file_path: '/b.ts' } },
        { name: 'Bash', id: 'toolu_real_3', input: { command: 'npm test' } },
      ],
    }))

    // 5. Tool results.
    analyzer.processMessage(makeUserMessage({
      toolResultId: 'toolu_real_2',
      content: 'file b contents',
      sessionId: 'sess-real',
    }))
    analyzer.processMessage(makeUserMessage({
      toolResultId: 'toolu_real_3',
      content: 'all tests pass',
      sessionId: 'sess-real',
    }))

    // 6. Context compaction (approaching 200k limit).
    analyzer.processMessage(makeCompactBoundary(190_000))

    // 7. After compaction: assistant spawns a sub-agent (Task tool).
    analyzer.processMessage(makeAssistantWithToolUse({
      messageId: uniqueMsgId(),
      toolName: 'Task',
      toolId: 'toolu_real_task',
      inputTokens: 3000,
      outputTokens: 150,
      sessionId: 'sess-real',
    }))

    // 8. Sub-agent messages with parent_tool_use_id.
    analyzer.processMessage(makeAssistantTextOnly({
      messageId: uniqueMsgId(),
      parentToolUseId: 'toolu_real_task',
      model: 'claude-haiku-4-5',
      inputTokens: 2000,
      outputTokens: 300,
      sessionId: 'sess-real',
    }))

    analyzer.processMessage(makeAssistantWithToolUse({
      messageId: uniqueMsgId(),
      toolName: 'Grep',
      toolId: 'toolu_sub_grep',
      inputTokens: 2500,
      outputTokens: 100,
      model: 'claude-haiku-4-5',
      sessionId: 'sess-real',
    }))

    // 9. Sub-agent tool result.
    analyzer.processMessage(makeUserMessage({
      toolResultId: 'toolu_sub_grep',
      content: 'grep results...',
      sessionId: 'sess-real',
    }))

    // 10. Sub-agent tool result fed back to main agent.
    analyzer.processMessage(makeUserMessage({
      toolResultId: 'toolu_real_task',
      content: 'Sub-agent found relevant patterns.',
      sessionId: 'sess-real',
    }))

    // 11. Final assistant response (text only).
    analyzer.processMessage(makeAssistantTextOnly({
      messageId: uniqueMsgId(),
      inputTokens: 4000,
      outputTokens: 800,
      text: 'Here is the analysis...',
      sessionId: 'sess-real',
    }))

    // 12. Result.
    analyzer.processMessage(makeResultSuccess({
      totalCostUsd: 0.25,
      numTurns: 5,
      durationMs: 45000,
      durationApiMs: 38000,
      sessionId: 'sess-real',
      modelUsage: {
        'claude-sonnet-4-5-20250929': {
          inputTokens: 20000,
          outputTokens: 1650,
          cacheReadInputTokens: 5000,
          cacheCreationInputTokens: 2000,
          webSearchRequests: 0,
          costUSD: 0.20,
          contextWindow: 200000,
        },
        'claude-haiku-4-5': {
          inputTokens: 4500,
          outputTokens: 400,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          webSearchRequests: 0,
          costUSD: 0.05,
          contextWindow: 200000,
        },
      },
    }))

    const summary = analyzer.getSessionSummary()

    assert.equal(summary.sessionId, 'sess-real')
    assert.equal(summary.model, 'claude-sonnet-4-5-20250929')
    assert.equal(summary.status, 'success')
    assert.equal(summary.numTurns, 5)
    assert.equal(summary.durationMs, 45000)
    assert.equal(summary.durationApiMs, 38000)
    assert.equal(summary.totalCostUsd, 0.25)
    assert.equal(summary.compactions, 1)
    assert.equal(Object.keys(summary.modelUsage).length, 2)

    // Tool usage: Read(2) + Bash(1) + Task(1) + Grep(1) = 5.
    const agg = analyzer.getToolAggregator()
    assert.equal(agg.get('Read')?.count, 2)
    assert.equal(agg.get('Bash')?.count, 1)
    assert.equal(agg.get('Task')?.count, 1)
    assert.equal(agg.get('Grep')?.count, 1)
    assert.equal(agg.getTotalCount(), 5)

    // Verify sub-agent events exist.
    const events = analyzer.getEvents()
    const subAgentEvents = events.filter((e) => e.parentToolUseId === 'toolu_real_task')
    assert.equal(subAgentEvents.length, 1) // The one with parentToolUseId set via fixture helper
    assert.equal(subAgentEvents[0].model, 'claude-haiku-4-5')
  })
})

describe('Edge: createAnalyzer factory with custom pricing', () => {
  test('custom pricing applies to cost calculations', () => {
    const analyzer = createAnalyzer({
      pricing: {
        'my-custom-model': {
          inputPerMTok: 10.00,
          outputPerMTok: 50.00,
          cacheWrite5mPerMTok: 12.50,
          cacheWrite1hPerMTok: 20.00,
          cacheReadPerMTok: 1.00,
        },
      },
    })

    analyzer.processMessage(makeSystemInit({ model: 'my-custom-model' }))
    analyzer.processMessage(makeAssistantTextOnly({
      messageId: uniqueMsgId(),
      inputTokens: 1_000_000,
      outputTokens: 0,
      model: 'my-custom-model',
    }))

    assert.equal(analyzer.getRunningCost().totalCostUsd, 10.00)
  })

  test('custom pricing does not include default models', () => {
    const analyzer = createAnalyzer({
      pricing: {
        'only-this-model': {
          inputPerMTok: 1.00,
          outputPerMTok: 2.00,
          cacheWrite5mPerMTok: 1.25,
          cacheWrite1hPerMTok: 2.00,
          cacheReadPerMTok: 0.10,
        },
      },
    })

    // claude-sonnet-4-5 is NOT in the custom pricing table, but lookupPricing
    // may still find it via the module-level PRICING fallback.
    analyzer.processMessage(makeAssistantTextOnly({
      messageId: uniqueMsgId(),
      inputTokens: 1_000_000,
      outputTokens: 0,
      model: 'claude-sonnet-4-5',
    }))

    // The cost calculator tries custom pricing first, then falls back to module-level.
    // So claude-sonnet-4-5 should still be found via lookupPricing().
    const cost = analyzer.getRunningCost()
    assert.equal(cost.totalCostUsd, 3.00, 'falls back to module-level pricing')
  })
})

describe('Edge: versioned model slugs', () => {
  test('model with date suffix maps to base pricing', () => {
    const analyzer = createAnalyzer()
    analyzer.processMessage(makeSystemInit({ model: 'claude-opus-4-5-20250929' }))

    analyzer.processMessage(makeAssistantTextOnly({
      messageId: uniqueMsgId(),
      inputTokens: 1_000_000,
      outputTokens: 0,
      model: 'claude-opus-4-5-20250929',
    }))

    // opus-4-5 inputPerMTok = 5.00
    assert.equal(analyzer.getRunningCost().totalCostUsd, 5.00)
  })
})
