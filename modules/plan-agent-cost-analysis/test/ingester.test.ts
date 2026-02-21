import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { EventIngester } from '../src/ingester.js'
import { CostCalculator } from '../src/cost-calculator.js'
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
} from './fixtures.js'

function createIngester() {
  const calculator = new CostCalculator()
  const ingester = new EventIngester(calculator)
  return { ingester, calculator }
}

describe('EventIngester — system messages', () => {
  test('ingests system init and captures model', () => {
    const { ingester } = createIngester()
    const event = ingester.ingest(makeSystemInit())

    assert.ok(event)
    assert.equal(event.type, 'system')
    assert.equal(event.subtype, 'init')
    assert.equal(event.model, 'claude-sonnet-4-5-20250929')
    assert.equal(event.sessionId, 'sess-1')
    assert.equal(ingester.getModel(), 'claude-sonnet-4-5-20250929')
  })

  test('ingests compact boundary', () => {
    const { ingester } = createIngester()
    const event = ingester.ingest(makeCompactBoundary(150000))

    assert.ok(event)
    assert.equal(event.type, 'system')
    assert.equal(event.subtype, 'compact_boundary')
  })

  test('returns null for unknown system subtypes', () => {
    const { ingester } = createIngester()
    const msg = { type: 'system', subtype: 'status', session_id: 'sess-1' }
    const event = ingester.ingest(msg as any)
    assert.equal(event, null)
  })
})

describe('EventIngester — assistant messages', () => {
  test('ingests text-only assistant message', () => {
    const { ingester } = createIngester()
    ingester.ingest(makeSystemInit()) // set model

    const event = ingester.ingest(makeAssistantTextOnly())

    assert.ok(event)
    assert.equal(event.type, 'assistant')
    assert.equal(event.messageId, 'msg-1')
    assert.ok(event.usage)
    assert.equal(event.usage.inputTokens, 100)
    assert.equal(event.usage.outputTokens, 50)
    assert.equal(event.toolCalls.length, 0)
  })

  test('ingests assistant message with tool use', () => {
    const { ingester } = createIngester()
    ingester.ingest(makeSystemInit())

    const event = ingester.ingest(makeAssistantWithToolUse())

    assert.ok(event)
    assert.equal(event.toolCalls.length, 1)
    assert.equal(event.toolCalls[0].toolName, 'Read')
    assert.equal(event.toolCalls[0].toolId, 'toolu_01abc')
    assert.deepEqual(event.toolCalls[0].input, { file_path: '/workspace/file.ts' })
  })

  test('ingests assistant message with multiple tool calls', () => {
    const { ingester } = createIngester()
    ingester.ingest(makeSystemInit())

    const event = ingester.ingest(makeAssistantMultiTool())

    assert.ok(event)
    assert.equal(event.toolCalls.length, 2)
    assert.equal(event.toolCalls[0].toolName, 'Read')
    assert.equal(event.toolCalls[1].toolName, 'Bash')
  })

  test('deduplicates by message ID', () => {
    const { ingester } = createIngester()
    ingester.ingest(makeSystemInit())

    const first = ingester.ingest(makeAssistantTextOnly({ messageId: 'msg-dup' }))
    const second = ingester.ingest(makeAssistantTextOnly({ messageId: 'msg-dup' }))

    assert.ok(first)
    assert.equal(second, null, 'duplicate message ID should return null')
  })

  test('allows different message IDs', () => {
    const { ingester } = createIngester()
    ingester.ingest(makeSystemInit())

    const first = ingester.ingest(makeAssistantTextOnly({ messageId: 'msg-a' }))
    const second = ingester.ingest(makeAssistantTextOnly({ messageId: 'msg-b' }))

    assert.ok(first)
    assert.ok(second)
  })

  test('computes cost for assistant messages', () => {
    const { ingester } = createIngester()
    ingester.ingest(makeSystemInit())

    const event = ingester.ingest(makeAssistantTextOnly({
      inputTokens: 1_000_000,
      outputTokens: 0,
      model: 'claude-sonnet-4-5',
    }))

    assert.ok(event)
    assert.equal(event.costUsd, 3.00) // $3/MTok for sonnet
  })

  test('captures parentToolUseId for subagent messages', () => {
    const { ingester } = createIngester()
    ingester.ingest(makeSystemInit())

    const event = ingester.ingest(makeAssistantTextOnly({
      messageId: 'msg-sub',
      parentToolUseId: 'toolu_parent_01',
    }))

    assert.ok(event)
    assert.equal(event.parentToolUseId, 'toolu_parent_01')
  })

  test('handles assistant message without usage', () => {
    const { ingester } = createIngester()
    const msg = {
      type: 'assistant',
      session_id: 'sess-1',
      parent_tool_use_id: null,
      message: { id: 'msg-no-usage', content: [] },
    }
    const event = ingester.ingest(msg as any)
    assert.ok(event)
    assert.equal(event.usage, null)
    assert.equal(event.costUsd, 0)
  })

  test('handles assistant message without content', () => {
    const { ingester } = createIngester()
    const msg = {
      type: 'assistant',
      session_id: 'sess-1',
      parent_tool_use_id: null,
      message: {
        id: 'msg-no-content',
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    }
    const event = ingester.ingest(msg as any)
    assert.ok(event)
    assert.equal(event.toolCalls.length, 0)
  })
})

describe('EventIngester — user messages', () => {
  test('ingests user message', () => {
    const { ingester } = createIngester()
    const event = ingester.ingest(makeUserMessage())

    assert.ok(event)
    assert.equal(event.type, 'user')
    assert.equal(event.usage, null)
  })
})

describe('EventIngester — result messages', () => {
  test('ingests success result', () => {
    const { ingester } = createIngester()
    const event = ingester.ingest(makeResultSuccess({ totalCostUsd: 0.0234 }))

    assert.ok(event)
    assert.equal(event.type, 'result')
    assert.equal(event.subtype, 'success')
    assert.equal(event.costUsd, 0.0234)
  })

  test('ingests error result', () => {
    const { ingester } = createIngester()
    const event = ingester.ingest(makeResultError())

    assert.ok(event)
    assert.equal(event.type, 'result')
    assert.equal(event.subtype, 'error_max_turns')
    assert.equal(event.costUsd, 0.15)
  })
})

describe('EventIngester — skipped messages', () => {
  test('skips stream_event messages', () => {
    const { ingester } = createIngester()
    const event = ingester.ingest(makeStreamEvent())
    assert.equal(event, null)
  })

  test('skips messages with no type', () => {
    const { ingester } = createIngester()
    const event = ingester.ingest({} as any)
    assert.equal(event, null)
  })

  test('skips unknown message types', () => {
    const { ingester } = createIngester()
    const event = ingester.ingest({ type: 'hook_started' } as any)
    assert.equal(event, null)
  })
})

describe('EventIngester — session tracking', () => {
  test('captures sessionId from first message', () => {
    const { ingester } = createIngester()
    assert.equal(ingester.getSessionId(), null)

    ingester.ingest(makeSystemInit({ session_id: 'sess-xyz' }))
    assert.equal(ingester.getSessionId(), 'sess-xyz')
  })

  test('does not overwrite sessionId from later messages', () => {
    const { ingester } = createIngester()
    ingester.ingest(makeSystemInit({ session_id: 'sess-first' }))
    ingester.ingest(makeAssistantTextOnly({ sessionId: 'sess-second', messageId: 'x' }))

    assert.equal(ingester.getSessionId(), 'sess-first')
  })

  test('reset clears all state', () => {
    const { ingester } = createIngester()
    ingester.ingest(makeSystemInit())
    ingester.ingest(makeAssistantTextOnly())

    ingester.reset()

    assert.equal(ingester.getModel(), null)
    assert.equal(ingester.getSessionId(), null)
    // After reset, the same messageId should be accepted again
    const event = ingester.ingest(makeAssistantTextOnly())
    assert.ok(event)
  })
})

describe('EventIngester — event IDs', () => {
  test('assigns sequential event IDs', () => {
    const { ingester } = createIngester()
    ingester.reset() // resets the counter

    const e1 = ingester.ingest(makeSystemInit())
    const e2 = ingester.ingest(makeAssistantTextOnly({ messageId: 'a' }))
    const e3 = ingester.ingest(makeUserMessage())

    assert.ok(e1)
    assert.ok(e2)
    assert.ok(e3)
    assert.equal(e1.eventId, 'evt_0')
    assert.equal(e2.eventId, 'evt_1')
    assert.equal(e3.eventId, 'evt_2')
  })
})
