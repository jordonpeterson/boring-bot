import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { buildSessionSummary } from '../src/session-summary.js'
import { CostCalculator } from '../src/cost-calculator.js'
import { ToolAggregator } from '../src/tool-aggregator.js'
import type { AgentEvent } from '../src/types.js'

function makeEvent(partial: Partial<AgentEvent>): AgentEvent {
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

describe('buildSessionSummary', () => {
  test('builds summary from events and result message', () => {
    const calculator = new CostCalculator()
    const aggregator = new ToolAggregator()

    const events: AgentEvent[] = [
      makeEvent({ type: 'system', subtype: 'init', model: 'claude-sonnet-4-5' }),
      makeEvent({
        type: 'assistant',
        usage: { inputTokens: 100, outputTokens: 50, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
        toolCalls: [{ toolName: 'Read', toolId: 'toolu_01', input: {} }],
        costUsd: 0.001,
      }),
      makeEvent({
        type: 'assistant',
        usage: { inputTokens: 200, outputTokens: 100, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
        costUsd: 0.002,
      }),
    ]

    // Simulate calculator tracking
    calculator.updateRunningTotal(events[1].usage!, 'claude-sonnet-4-5')
    calculator.updateRunningTotal(events[2].usage!, 'claude-sonnet-4-5')

    // Simulate aggregator
    aggregator.record(events[1].toolCalls)

    const resultMsg = {
      type: 'result',
      subtype: 'success',
      session_id: 'sess-1',
      duration_ms: 10000,
      duration_api_ms: 8000,
      num_turns: 2,
      total_cost_usd: 0.05,
      usage: {
        input_tokens: 300,
        output_tokens: 150,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      modelUsage: {
        'claude-sonnet-4-5': {
          inputTokens: 300,
          outputTokens: 150,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          webSearchRequests: 0,
          costUSD: 0.05,
          contextWindow: 200000,
        },
      },
      permission_denials: [],
    }

    const summary = buildSessionSummary(events, resultMsg, calculator, aggregator)

    assert.equal(summary.sessionId, 'sess-1')
    assert.equal(summary.model, 'claude-sonnet-4-5')
    assert.equal(summary.status, 'success')
    assert.equal(summary.durationMs, 10000)
    assert.equal(summary.durationApiMs, 8000)
    assert.equal(summary.numTurns, 2)
    assert.equal(summary.totalCostUsd, 0.05) // from result message
    assert.equal(summary.tokenUsage.inputTokens, 300) // from result usage
    assert.equal(summary.tokenUsage.outputTokens, 150)
    assert.ok(summary.toolCallSummary['Read'])
    assert.equal(summary.toolCallSummary['Read'].count, 1)
    assert.equal(summary.compactions, 0)
    assert.equal(summary.errors.length, 0)
  })

  test('builds summary without result message (incomplete session)', () => {
    const calculator = new CostCalculator()
    const aggregator = new ToolAggregator()

    const events: AgentEvent[] = [
      makeEvent({ type: 'system', subtype: 'init' }),
      makeEvent({
        type: 'assistant',
        usage: { inputTokens: 100, outputTokens: 50, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
        costUsd: 0.001,
      }),
    ]

    calculator.updateRunningTotal(events[1].usage!, 'claude-sonnet-4-5')

    const summary = buildSessionSummary(events, null, calculator, aggregator)

    assert.equal(summary.status, 'incomplete')
    assert.equal(summary.durationMs, 0)
    assert.equal(summary.numTurns, 1) // counted from events
    // Uses computed usage since no result message
    assert.equal(summary.tokenUsage.inputTokens, 100)
  })

  test('captures error subtypes and error messages', () => {
    const calculator = new CostCalculator()
    const aggregator = new ToolAggregator()

    const events: AgentEvent[] = [
      makeEvent({ type: 'system', subtype: 'init' }),
    ]

    const resultMsg = {
      type: 'result',
      subtype: 'error_max_turns',
      session_id: 'sess-1',
      duration_ms: 60000,
      duration_api_ms: 55000,
      num_turns: 10,
      total_cost_usd: 0.15,
      usage: {
        input_tokens: 8000,
        output_tokens: 2000,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      modelUsage: {},
      permission_denials: [],
      errors: ['Maximum number of turns (10) exceeded'],
    }

    const summary = buildSessionSummary(events, resultMsg, calculator, aggregator)

    assert.equal(summary.status, 'error_max_turns')
    assert.equal(summary.numTurns, 10)
    assert.equal(summary.totalCostUsd, 0.15)
    assert.deepEqual(summary.errors, ['Maximum number of turns (10) exceeded'])
  })

  test('counts compactions', () => {
    const calculator = new CostCalculator()
    const aggregator = new ToolAggregator()

    const events: AgentEvent[] = [
      makeEvent({ type: 'system', subtype: 'init' }),
      makeEvent({ type: 'system', subtype: 'compact_boundary' }),
      makeEvent({ type: 'assistant' }),
      makeEvent({ type: 'system', subtype: 'compact_boundary' }),
    ]

    const summary = buildSessionSummary(events, null, calculator, aggregator)
    assert.equal(summary.compactions, 2)
  })

  test('counts permission denials', () => {
    const calculator = new CostCalculator()
    const aggregator = new ToolAggregator()

    const resultMsg = {
      type: 'result',
      subtype: 'success',
      total_cost_usd: 0.01,
      duration_ms: 5000,
      duration_api_ms: 4000,
      num_turns: 1,
      usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      modelUsage: {},
      permission_denials: [
        { tool_name: 'Bash', tool_use_id: 'toolu_01', tool_input: {} },
        { tool_name: 'Write', tool_use_id: 'toolu_02', tool_input: {} },
      ],
    }

    const summary = buildSessionSummary([], resultMsg, calculator, aggregator)
    assert.equal(summary.permissionDenials, 2)
  })

  test('extracts per-model usage from result', () => {
    const calculator = new CostCalculator()
    const aggregator = new ToolAggregator()

    const resultMsg = {
      type: 'result',
      subtype: 'success',
      total_cost_usd: 0.10,
      duration_ms: 10000,
      duration_api_ms: 8000,
      num_turns: 3,
      usage: { input_tokens: 1000, output_tokens: 500, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      modelUsage: {
        'claude-sonnet-4-5': {
          inputTokens: 800,
          outputTokens: 400,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          webSearchRequests: 0,
          costUSD: 0.08,
          contextWindow: 200000,
        },
        'claude-haiku-4-5': {
          inputTokens: 200,
          outputTokens: 100,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          webSearchRequests: 1,
          costUSD: 0.02,
          contextWindow: 200000,
        },
      },
      permission_denials: [],
    }

    const summary = buildSessionSummary([], resultMsg, calculator, aggregator)
    assert.ok(summary.modelUsage['claude-sonnet-4-5'])
    assert.ok(summary.modelUsage['claude-haiku-4-5'])
    assert.equal(summary.modelUsage['claude-sonnet-4-5'].costUSD, 0.08)
    assert.equal(summary.modelUsage['claude-haiku-4-5'].webSearchRequests, 1)
  })
})
