import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { Analyzer, createAnalyzer } from '../src/analyzer.js'
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

describe('Analyzer — processMessage', () => {
  test('processes a full session lifecycle', () => {
    const analyzer = createAnalyzer()

    // 1. System init
    const r1 = analyzer.processMessage(makeSystemInit())
    assert.ok(r1.event)
    assert.equal(r1.event.type, 'system')
    assert.equal(r1.isResult, false)

    // 2. Assistant text
    const r2 = analyzer.processMessage(makeAssistantTextOnly({ messageId: 'msg-1' }))
    assert.ok(r2.event)
    assert.equal(r2.event.type, 'assistant')
    assert.ok(r2.runningCost.totalCostUsd > 0 || r2.runningCost.totalInputTokens > 0)

    // 3. Assistant with tool use
    const r3 = analyzer.processMessage(makeAssistantWithToolUse({ messageId: 'msg-2' }))
    assert.ok(r3.event)
    assert.equal(r3.event.toolCalls.length, 1)

    // 4. User message (tool result)
    const r4 = analyzer.processMessage(makeUserMessage())
    assert.ok(r4.event)
    assert.equal(r4.event.type, 'user')

    // 5. Result
    const r5 = analyzer.processMessage(makeResultSuccess())
    assert.ok(r5.event)
    assert.equal(r5.isResult, true)

    // Check final state
    assert.equal(analyzer.getEvents().length, 5)

    const summary = analyzer.getSessionSummary()
    assert.equal(summary.status, 'success')
    assert.equal(summary.totalCostUsd, 0.0234)
    assert.ok(summary.toolCallSummary['Read'])
  })

  test('skips stream events', () => {
    const analyzer = createAnalyzer()
    const result = analyzer.processMessage(makeStreamEvent())
    assert.equal(result.event, null)
    assert.equal(result.isResult, false)
  })

  test('deduplicates assistant messages by message ID', () => {
    const analyzer = createAnalyzer()
    analyzer.processMessage(makeSystemInit())

    analyzer.processMessage(makeAssistantTextOnly({ messageId: 'dup' }))
    const r2 = analyzer.processMessage(makeAssistantTextOnly({ messageId: 'dup' }))

    assert.equal(r2.event, null)
    assert.equal(analyzer.getEvents().length, 2) // init + 1 assistant
  })

  test('tracks tool calls via aggregator', () => {
    const analyzer = createAnalyzer()
    analyzer.processMessage(makeSystemInit())
    analyzer.processMessage(makeAssistantWithToolUse({
      messageId: 'msg-1',
      toolName: 'Read',
      toolId: 'toolu_01',
    }))
    analyzer.processMessage(makeAssistantWithToolUse({
      messageId: 'msg-2',
      toolName: 'Write',
      toolId: 'toolu_02',
    }))
    analyzer.processMessage(makeAssistantWithToolUse({
      messageId: 'msg-3',
      toolName: 'Read',
      toolId: 'toolu_03',
    }))

    const agg = analyzer.getToolAggregator()
    assert.equal(agg.getTotalCount(), 3)
    assert.equal(agg.get('Read')?.count, 2)
    assert.equal(agg.get('Write')?.count, 1)
  })

  test('accumulates running cost across messages', () => {
    const analyzer = createAnalyzer()
    analyzer.processMessage(makeSystemInit({ model: 'claude-sonnet-4-5' }))

    analyzer.processMessage(makeAssistantTextOnly({
      messageId: 'msg-1',
      inputTokens: 1_000_000,
      outputTokens: 0,
      model: 'claude-sonnet-4-5',
    }))

    const cost1 = analyzer.getRunningCost()
    assert.equal(cost1.totalCostUsd, 3.00)
    assert.equal(cost1.messageCount, 1)

    analyzer.processMessage(makeAssistantTextOnly({
      messageId: 'msg-2',
      inputTokens: 1_000_000,
      outputTokens: 0,
      model: 'claude-sonnet-4-5',
    }))

    const cost2 = analyzer.getRunningCost()
    assert.equal(cost2.totalCostUsd, 6.00)
    assert.equal(cost2.messageCount, 2)
  })
})

describe('Analyzer — processStreamEvent', () => {
  test('processes event-type StreamEvents', () => {
    const analyzer = createAnalyzer()
    const streamEv = wrapAsStreamEvent(makeSystemInit())

    const result = analyzer.processStreamEvent(streamEv)
    assert.ok(result)
    assert.ok(result.event)
    assert.equal(result.event.type, 'system')
  })

  test('returns null for error-type StreamEvents', () => {
    const analyzer = createAnalyzer()
    const errEv = { type: 'error' as const, runId: 'run-1', text: 'something broke' }

    const result = analyzer.processStreamEvent(errEv)
    assert.equal(result, null)
  })

  test('returns null for done-type StreamEvents', () => {
    const analyzer = createAnalyzer()
    const doneEv = { type: 'done' as const, runId: 'run-1', exitCode: 0, logPath: '/tmp/log' }

    const result = analyzer.processStreamEvent(doneEv)
    assert.equal(result, null)
  })

  test('processes a full session via StreamEvents', () => {
    const analyzer = createAnalyzer()

    const events = [
      wrapAsStreamEvent(makeSystemInit(), 'run-1', 0),
      wrapAsStreamEvent(makeAssistantTextOnly({ messageId: 'msg-1' }), 'run-1', 1),
      wrapAsStreamEvent(makeAssistantWithToolUse({ messageId: 'msg-2' }), 'run-1', 2),
      wrapAsStreamEvent(makeUserMessage(), 'run-1', 3),
      wrapAsStreamEvent(makeResultSuccess(), 'run-1', 4),
    ]

    for (const ev of events) {
      analyzer.processStreamEvent(ev)
    }

    const summary = analyzer.getSessionSummary()
    assert.equal(summary.status, 'success')
    assert.equal(summary.totalCostUsd, 0.0234)
  })
})

describe('Analyzer — getSessionSummary', () => {
  test('uses authoritative cost from result message', () => {
    const analyzer = createAnalyzer()
    analyzer.processMessage(makeSystemInit())
    analyzer.processMessage(makeAssistantTextOnly({ messageId: 'a' }))
    analyzer.processMessage(makeResultSuccess({ totalCostUsd: 0.999 }))

    const summary = analyzer.getSessionSummary()
    assert.equal(summary.totalCostUsd, 0.999)
  })

  test('includes computed cost for comparison', () => {
    const analyzer = createAnalyzer()
    analyzer.processMessage(makeSystemInit({ model: 'claude-sonnet-4-5' }))
    analyzer.processMessage(makeAssistantTextOnly({
      messageId: 'a',
      inputTokens: 1_000_000,
      outputTokens: 0,
      model: 'claude-sonnet-4-5',
    }))
    analyzer.processMessage(makeResultSuccess({ totalCostUsd: 3.50 }))

    const summary = analyzer.getSessionSummary()
    assert.equal(summary.totalCostUsd, 3.50)     // authoritative
    assert.equal(summary.computedCostUsd, 3.00)   // our calculation
  })

  test('handles error result messages', () => {
    const analyzer = createAnalyzer()
    analyzer.processMessage(makeSystemInit())
    analyzer.processMessage(makeResultError({
      subtype: 'error_max_budget_usd',
      errors: ['Budget exceeded'],
    }))

    const summary = analyzer.getSessionSummary()
    assert.equal(summary.status, 'error_max_budget_usd')
    assert.deepEqual(summary.errors, ['Budget exceeded'])
  })
})

describe('Analyzer — reset', () => {
  test('clears all state', () => {
    const analyzer = createAnalyzer()
    analyzer.processMessage(makeSystemInit())
    analyzer.processMessage(makeAssistantTextOnly({ messageId: 'a' }))
    analyzer.processMessage(makeAssistantWithToolUse({ messageId: 'b' }))

    analyzer.reset()

    assert.equal(analyzer.getEvents().length, 0)
    assert.equal(analyzer.getRunningCost().totalCostUsd, 0)
    assert.equal(analyzer.getToolAggregator().getTotalCount(), 0)

    const summary = analyzer.getSessionSummary()
    assert.equal(summary.status, 'incomplete')
  })

  test('can process new session after reset', () => {
    const analyzer = createAnalyzer()
    analyzer.processMessage(makeSystemInit())
    analyzer.processMessage(makeResultSuccess())
    analyzer.reset()

    analyzer.processMessage(makeSystemInit({ session_id: 'sess-2' }))
    analyzer.processMessage(makeAssistantTextOnly({ messageId: 'new-msg', sessionId: 'sess-2' }))

    assert.equal(analyzer.getEvents().length, 2)
  })
})

describe('Analyzer — createAnalyzer factory', () => {
  test('creates analyzer with default pricing', () => {
    const analyzer = createAnalyzer()
    assert.ok(analyzer instanceof Analyzer)
  })

  test('creates analyzer with custom pricing', () => {
    const analyzer = createAnalyzer({
      pricing: {
        'custom-model': {
          inputPerMTok: 1.00,
          outputPerMTok: 2.00,
          cacheWrite5mPerMTok: 1.25,
          cacheWrite1hPerMTok: 2.00,
          cacheReadPerMTok: 0.10,
        },
      },
    })

    analyzer.processMessage({
      type: 'assistant',
      session_id: 'sess-1',
      parent_tool_use_id: null,
      message: {
        id: 'msg-custom',
        content: [],
        model: 'custom-model',
        usage: {
          input_tokens: 1_000_000,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    } as any)

    assert.equal(analyzer.getRunningCost().totalCostUsd, 1.00)
  })
})
