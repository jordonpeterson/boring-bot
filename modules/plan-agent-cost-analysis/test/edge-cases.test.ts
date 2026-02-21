/**
 * Edge-case tests for EventIngester and CostCalculator.
 *
 * Covers unusual event shapes, boundary conditions in cost arithmetic,
 * and SDK message variants that appear in real-world Claude Agent SDK
 * sessions (thinking blocks, redacted thinking, server tool use,
 * MCP-namespaced tools, web search results, citations, etc.).
 *
 * Uses node:test + node:assert/strict.  Fixtures cast minimal objects to
 * SDKMessage because the real type is a large opaque union from the SDK.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { EventIngester } from '../src/ingester.js'
import { CostCalculator } from '../src/cost-calculator.js'
import { lookupPricing, PRICING } from '../src/pricing.js'
import type { SDKMessage } from '@boring-bot/code-executor'
import type { TokenUsage, PricingEntry } from '../src/types.js'

// ─── Helpers ───────────────────────────────────────────────────────────────────

function createIngester(pricing?: Record<string, PricingEntry>) {
  const calculator = new CostCalculator(pricing)
  const ingester = new EventIngester(calculator)
  ingester.reset() // reset the global event counter for deterministic IDs
  return { ingester, calculator }
}

function makeUsage(overrides: Partial<TokenUsage> = {}): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    ...overrides,
  }
}

/** Shorthand to build a raw SDKMessage-shaped object. */
function raw(obj: Record<string, unknown>): SDKMessage {
  return obj as unknown as SDKMessage
}

// ─── Deterministic pricing for arithmetic tests ────────────────────────────────

const exactPricing: Record<string, PricingEntry> = {
  'exact-model': {
    inputPerMTok: 10.0,
    outputPerMTok: 20.0,
    cacheWrite5mPerMTok: 12.5,
    cacheWrite1hPerMTok: 20.0,
    cacheReadPerMTok: 1.0,
  },
}

// ════════════════════════════════════════════════════════════════════════════════
//  SECTION 1 — Thinking & Redacted Thinking Content Blocks
// ════════════════════════════════════════════════════════════════════════════════

describe('Edge: thinking content blocks', () => {
  test('assistant message with a thinking block is treated like text (no tool_use)', () => {
    const { ingester } = createIngester()
    const event = ingester.ingest(raw({
      type: 'assistant',
      session_id: 'sess-1',
      parent_tool_use_id: null,
      message: {
        id: 'msg-thinking-1',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-5',
        content: [
          {
            type: 'thinking',
            thinking: 'Let me reason through this step by step...',
            signature: 'sig_abc123',
          },
          { type: 'text', text: 'Here is my answer.' },
        ],
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 500,
          output_tokens: 200,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    }))

    assert.ok(event)
    assert.equal(event.type, 'assistant')
    assert.equal(event.toolCalls.length, 0, 'thinking blocks should not be extracted as tool calls')
    assert.ok(event.usage)
    assert.equal(event.usage.inputTokens, 500)
    assert.equal(event.usage.outputTokens, 200)
  })

  test('assistant message with redacted_thinking block is ingested normally', () => {
    const { ingester } = createIngester()
    const event = ingester.ingest(raw({
      type: 'assistant',
      session_id: 'sess-1',
      parent_tool_use_id: null,
      message: {
        id: 'msg-redacted-1',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-5',
        content: [
          {
            type: 'redacted_thinking',
            data: 'base64encodeddata==',
          },
          { type: 'text', text: 'My response after redacted thinking.' },
        ],
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 800,
          output_tokens: 150,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    }))

    assert.ok(event)
    assert.equal(event.toolCalls.length, 0, 'redacted_thinking should not be extracted as tool calls')
    assert.ok(event.usage)
    assert.equal(event.usage.inputTokens, 800)
  })

  test('mixed thinking + text + tool_use only extracts the tool_use blocks', () => {
    const { ingester } = createIngester()
    const event = ingester.ingest(raw({
      type: 'assistant',
      session_id: 'sess-1',
      parent_tool_use_id: null,
      message: {
        id: 'msg-mixed-thinking-tool',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-5',
        content: [
          {
            type: 'thinking',
            thinking: 'I need to read the file first.',
            signature: 'sig_xyz',
          },
          { type: 'text', text: 'Let me check that file.' },
          {
            type: 'tool_use',
            id: 'toolu_think_read',
            name: 'Read',
            input: { file_path: '/workspace/main.ts' },
          },
        ],
        stop_reason: 'tool_use',
        usage: {
          input_tokens: 300,
          output_tokens: 100,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    }))

    assert.ok(event)
    assert.equal(event.toolCalls.length, 1)
    assert.equal(event.toolCalls[0].toolName, 'Read')
    assert.equal(event.toolCalls[0].toolId, 'toolu_think_read')
  })

  test('interleaved thinking blocks between tool_use blocks', () => {
    const { ingester } = createIngester()
    const event = ingester.ingest(raw({
      type: 'assistant',
      session_id: 'sess-1',
      parent_tool_use_id: null,
      message: {
        id: 'msg-interleaved',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-4-6',
        content: [
          { type: 'thinking', thinking: 'First thought...', signature: 'sig_1' },
          { type: 'tool_use', id: 'toolu_01', name: 'Read', input: { file_path: '/a.ts' } },
          { type: 'thinking', thinking: 'Second thought after tool result...', signature: 'sig_2' },
          { type: 'tool_use', id: 'toolu_02', name: 'Write', input: { file_path: '/b.ts', content: 'x' } },
          { type: 'thinking', thinking: 'Third thought...', signature: 'sig_3' },
          { type: 'text', text: 'Done.' },
        ],
        stop_reason: 'tool_use',
        usage: {
          input_tokens: 1000,
          output_tokens: 500,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    }))

    assert.ok(event)
    assert.equal(event.toolCalls.length, 2)
    assert.equal(event.toolCalls[0].toolName, 'Read')
    assert.equal(event.toolCalls[1].toolName, 'Write')
  })
})

// ════════════════════════════════════════════════════════════════════════════════
//  SECTION 2 — Null / Undefined / Missing Usage Fields
// ════════════════════════════════════════════════════════════════════════════════

describe('Edge: null and undefined usage fields', () => {
  test('usage with all fields explicitly null coerces to zeros', () => {
    const { ingester } = createIngester()
    const event = ingester.ingest(raw({
      type: 'assistant',
      session_id: 'sess-1',
      parent_tool_use_id: null,
      message: {
        id: 'msg-null-usage-fields',
        model: 'claude-sonnet-4-5',
        usage: {
          input_tokens: null,
          output_tokens: null,
          cache_creation_input_tokens: null,
          cache_read_input_tokens: null,
        },
        content: [{ type: 'text', text: 'hi' }],
      },
    }))

    assert.ok(event)
    assert.ok(event.usage)
    // null ?? 0 → 0 in normaliseUsage
    assert.equal(event.usage.inputTokens, 0)
    assert.equal(event.usage.outputTokens, 0)
    assert.equal(event.usage.cacheCreationInputTokens, 0)
    assert.equal(event.usage.cacheReadInputTokens, 0)
    assert.equal(event.costUsd, 0)
  })

  test('usage with missing cache fields defaults to zero', () => {
    const { ingester } = createIngester()
    const event = ingester.ingest(raw({
      type: 'assistant',
      session_id: 'sess-1',
      parent_tool_use_id: null,
      message: {
        id: 'msg-partial-usage',
        model: 'claude-sonnet-4-5',
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          // cache fields entirely missing
        },
        content: [],
      },
    }))

    assert.ok(event)
    assert.ok(event.usage)
    assert.equal(event.usage.inputTokens, 100)
    assert.equal(event.usage.outputTokens, 50)
    assert.equal(event.usage.cacheCreationInputTokens, 0)
    assert.equal(event.usage.cacheReadInputTokens, 0)
  })

  test('assistant message where inner message field is null returns null', () => {
    const { ingester } = createIngester()
    const event = ingester.ingest(raw({
      type: 'assistant',
      session_id: 'sess-1',
      parent_tool_use_id: null,
      message: null,
    }))

    assert.equal(event, null)
  })

  test('assistant message where inner message field is undefined returns null', () => {
    const { ingester } = createIngester()
    const event = ingester.ingest(raw({
      type: 'assistant',
      session_id: 'sess-1',
      parent_tool_use_id: null,
      // message field entirely absent
    }))

    assert.equal(event, null)
  })

  test('usage object itself is null — treated as no usage', () => {
    const { ingester } = createIngester()
    const event = ingester.ingest(raw({
      type: 'assistant',
      session_id: 'sess-1',
      parent_tool_use_id: null,
      message: {
        id: 'msg-no-usage-obj',
        model: 'claude-sonnet-4-5',
        usage: null,
        content: [{ type: 'text', text: 'hello' }],
      },
    }))

    assert.ok(event)
    assert.equal(event.usage, null)
    assert.equal(event.costUsd, 0)
  })

  test('usage object is undefined — treated as no usage', () => {
    const { ingester } = createIngester()
    const event = ingester.ingest(raw({
      type: 'assistant',
      session_id: 'sess-1',
      parent_tool_use_id: null,
      message: {
        id: 'msg-undef-usage',
        model: 'claude-sonnet-4-5',
        content: [{ type: 'text', text: 'hello' }],
      },
    }))

    assert.ok(event)
    assert.equal(event.usage, null)
    assert.equal(event.costUsd, 0)
  })
})

// ════════════════════════════════════════════════════════════════════════════════
//  SECTION 3 — Negative & Very Large Token Counts
// ════════════════════════════════════════════════════════════════════════════════

describe('Edge: negative token counts', () => {
  test('negative input tokens produce negative cost (no clamping)', () => {
    const calc = new CostCalculator(exactPricing)
    const usage = makeUsage({ inputTokens: -1_000_000 })
    const cost = calc.calculate(usage, 'exact-model')
    // The implementation does not clamp negative values.
    // -1M / 1M = -1.0, * $10/MTok = -$10
    assert.equal(cost, -10.0)
  })

  test('negative token counts are accumulated into running totals', () => {
    const calc = new CostCalculator(exactPricing)
    calc.updateRunningTotal(makeUsage({ inputTokens: 1_000_000 }), 'exact-model')
    calc.updateRunningTotal(makeUsage({ inputTokens: -500_000 }), 'exact-model')

    const running = calc.getRunningCost()
    assert.equal(running.totalInputTokens, 500_000)
    // 10 + (-5) = 5
    assert.equal(running.totalCostUsd, 5.0)
  })

  test('all-negative usage produces negative cost', () => {
    const calc = new CostCalculator(exactPricing)
    const usage = makeUsage({
      inputTokens: -100,
      outputTokens: -200,
      cacheCreationInputTokens: -300,
      cacheReadInputTokens: -400,
    })
    const cost = calc.calculate(usage, 'exact-model')
    assert.ok(cost < 0, 'all-negative usage should yield negative cost')
  })
})

describe('Edge: very large token counts', () => {
  test('handles millions of tokens without overflow', () => {
    const calc = new CostCalculator(exactPricing)
    const usage = makeUsage({
      inputTokens: 10_000_000,    // 10M tokens
      outputTokens: 5_000_000,   // 5M tokens
    })
    const cost = calc.calculate(usage, 'exact-model')
    // (10M / 1M) * 10 + (5M / 1M) * 20 = 100 + 100 = 200
    assert.equal(cost, 200.0)
  })

  test('handles hundreds of millions of tokens', () => {
    const calc = new CostCalculator(exactPricing)
    const usage = makeUsage({ inputTokens: 500_000_000 }) // 500M tokens
    const cost = calc.calculate(usage, 'exact-model')
    // (500M / 1M) * 10 = 5000
    assert.equal(cost, 5000.0)
  })

  test('accumulates very large counts in running total', () => {
    const calc = new CostCalculator(exactPricing)
    for (let i = 0; i < 100; i++) {
      calc.updateRunningTotal(makeUsage({ inputTokens: 10_000_000 }), 'exact-model')
    }
    const running = calc.getRunningCost()
    assert.equal(running.totalInputTokens, 1_000_000_000) // 1 billion
    assert.equal(running.messageCount, 100)
    // 100 * (10M / 1M) * 10 = 10_000
    assert.equal(running.totalCostUsd, 10_000.0)
  })

  test('Number.MAX_SAFE_INTEGER tokens do not produce Infinity', () => {
    const calc = new CostCalculator(exactPricing)
    const usage = makeUsage({ inputTokens: Number.MAX_SAFE_INTEGER })
    const cost = calc.calculate(usage, 'exact-model')
    assert.ok(Number.isFinite(cost), 'cost should remain finite')
    assert.ok(cost > 0, 'cost should be positive')
  })
})

// ════════════════════════════════════════════════════════════════════════════════
//  SECTION 4 — Floating-Point Precision
// ════════════════════════════════════════════════════════════════════════════════

describe('Edge: floating-point precision in cost calculation', () => {
  test('classic 0.1 + 0.2 scenario — cost adds up reasonably', () => {
    // Pricing that would trigger classic FP issues
    const fpPricing: Record<string, PricingEntry> = {
      'fp-model': {
        inputPerMTok: 0.1,
        outputPerMTok: 0.2,
        cacheWrite5mPerMTok: 0.3,
        cacheWrite1hPerMTok: 0.4,
        cacheReadPerMTok: 0.5,
      },
    }
    const calc = new CostCalculator(fpPricing)
    const usage = makeUsage({
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    })
    const cost = calc.calculate(usage, 'fp-model')
    // 0.1 + 0.2 in IEEE 754 = 0.30000000000000004
    // We verify the result is close enough for practical purposes
    assert.ok(
      Math.abs(cost - 0.3) < 1e-10,
      `expected ~0.3, got ${cost}`,
    )
  })

  test('many small messages accumulate without catastrophic precision loss', () => {
    const calc = new CostCalculator(exactPricing)
    // 10000 messages each with 1 input token
    for (let i = 0; i < 10_000; i++) {
      calc.updateRunningTotal(makeUsage({ inputTokens: 1 }), 'exact-model')
    }
    const running = calc.getRunningCost()
    assert.equal(running.totalInputTokens, 10_000)
    // Each message: (1 / 1_000_000) * 10 = 0.00001
    // Total: 10000 * 0.00001 = 0.1
    assert.ok(
      Math.abs(running.totalCostUsd - 0.1) < 1e-10,
      `expected ~0.1, got ${running.totalCostUsd}`,
    )
  })

  test('real-world Sonnet pricing with typical token counts', () => {
    const calc = new CostCalculator()
    // Typical agent turn: 50k input (mostly cache-read), 1k output, 2k cache-create
    const usage = makeUsage({
      inputTokens: 5_000,
      outputTokens: 1_000,
      cacheCreationInputTokens: 2_000,
      cacheReadInputTokens: 45_000,
    })
    const cost = calc.calculate(usage, 'claude-sonnet-4-5')
    // (5000/1M)*3 + (1000/1M)*15 + (2000/1M)*3.75 + (45000/1M)*0.30
    // = 0.015 + 0.015 + 0.0075 + 0.0135
    // = 0.051
    assert.ok(
      Math.abs(cost - 0.051) < 1e-10,
      `expected ~0.051, got ${cost}`,
    )
  })

  test('zero tokens in every category yields exactly zero cost', () => {
    const calc = new CostCalculator(exactPricing)
    const usage = makeUsage()
    const cost = calc.calculate(usage, 'exact-model')
    assert.equal(cost, 0)
    // Verify it's positive zero, not negative zero
    assert.equal(Object.is(cost, 0), true)
  })
})

// ════════════════════════════════════════════════════════════════════════════════
//  SECTION 5 — Empty Content Arrays & Edge Content Shapes
// ════════════════════════════════════════════════════════════════════════════════

describe('Edge: empty and unusual content arrays', () => {
  test('empty content array yields zero tool calls', () => {
    const { ingester } = createIngester()
    const event = ingester.ingest(raw({
      type: 'assistant',
      session_id: 'sess-1',
      parent_tool_use_id: null,
      message: {
        id: 'msg-empty-content',
        model: 'claude-sonnet-4-5',
        content: [],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    }))

    assert.ok(event)
    assert.equal(event.toolCalls.length, 0)
  })

  test('content blocks with unknown types are silently ignored', () => {
    const { ingester } = createIngester()
    const event = ingester.ingest(raw({
      type: 'assistant',
      session_id: 'sess-1',
      parent_tool_use_id: null,
      message: {
        id: 'msg-unknown-blocks',
        model: 'claude-sonnet-4-5',
        content: [
          { type: 'server_tool_use', id: 'srvtoolu_01', name: 'web_search', input: { query: 'test' } },
          { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_01', content: [] },
          { type: 'citation', cited_text: 'some text', url: 'https://example.com' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } },
        ],
        usage: { input_tokens: 100, output_tokens: 50 },
      },
    }))

    assert.ok(event)
    // Only `tool_use` type blocks are extracted; server_tool_use, web_search_tool_result,
    // citation, and image blocks are not tool calls.
    assert.equal(event.toolCalls.length, 0)
  })

  test('content with only text blocks — no tool calls', () => {
    const { ingester } = createIngester()
    const event = ingester.ingest(raw({
      type: 'assistant',
      session_id: 'sess-1',
      parent_tool_use_id: null,
      message: {
        id: 'msg-multitext',
        model: 'claude-sonnet-4-5',
        content: [
          { type: 'text', text: 'First paragraph.' },
          { type: 'text', text: 'Second paragraph.' },
          { type: 'text', text: 'Third paragraph.' },
        ],
        usage: { input_tokens: 50, output_tokens: 30 },
      },
    }))

    assert.ok(event)
    assert.equal(event.toolCalls.length, 0)
  })
})

// ════════════════════════════════════════════════════════════════════════════════
//  SECTION 6 — Multiple Tool Use Blocks
// ════════════════════════════════════════════════════════════════════════════════

describe('Edge: multiple and unusual tool_use blocks', () => {
  test('many tool_use blocks (5+) in a single message', () => {
    const tools = [
      { type: 'tool_use', id: 'toolu_01', name: 'Read', input: { file_path: '/a.ts' } },
      { type: 'tool_use', id: 'toolu_02', name: 'Read', input: { file_path: '/b.ts' } },
      { type: 'tool_use', id: 'toolu_03', name: 'Read', input: { file_path: '/c.ts' } },
      { type: 'tool_use', id: 'toolu_04', name: 'Bash', input: { command: 'ls' } },
      { type: 'tool_use', id: 'toolu_05', name: 'Write', input: { file_path: '/d.ts', content: '...' } },
    ]
    const { ingester } = createIngester()
    const event = ingester.ingest(raw({
      type: 'assistant',
      session_id: 'sess-1',
      parent_tool_use_id: null,
      message: {
        id: 'msg-5-tools',
        model: 'claude-sonnet-4-5',
        content: [{ type: 'text', text: 'Doing multiple things.' }, ...tools],
        usage: { input_tokens: 500, output_tokens: 200 },
      },
    }))

    assert.ok(event)
    assert.equal(event.toolCalls.length, 5)
    assert.equal(event.toolCalls[0].toolName, 'Read')
    assert.equal(event.toolCalls[3].toolName, 'Bash')
    assert.equal(event.toolCalls[4].toolName, 'Write')
  })

  test('tool_use block with missing name defaults to "unknown"', () => {
    const { ingester } = createIngester()
    const event = ingester.ingest(raw({
      type: 'assistant',
      session_id: 'sess-1',
      parent_tool_use_id: null,
      message: {
        id: 'msg-no-tool-name',
        model: 'claude-sonnet-4-5',
        content: [
          { type: 'tool_use', id: 'toolu_noname', input: { key: 'value' } },
        ],
        usage: { input_tokens: 50, output_tokens: 20 },
      },
    }))

    assert.ok(event)
    assert.equal(event.toolCalls.length, 1)
    assert.equal(event.toolCalls[0].toolName, 'unknown')
  })

  test('tool_use block with missing id defaults to "unknown"', () => {
    const { ingester } = createIngester()
    const event = ingester.ingest(raw({
      type: 'assistant',
      session_id: 'sess-1',
      parent_tool_use_id: null,
      message: {
        id: 'msg-no-tool-id',
        model: 'claude-sonnet-4-5',
        content: [
          { type: 'tool_use', name: 'Read', input: { file_path: '/x.ts' } },
        ],
        usage: { input_tokens: 50, output_tokens: 20 },
      },
    }))

    assert.ok(event)
    assert.equal(event.toolCalls[0].toolId, 'unknown')
  })

  test('tool_use block with missing input defaults to empty object', () => {
    const { ingester } = createIngester()
    const event = ingester.ingest(raw({
      type: 'assistant',
      session_id: 'sess-1',
      parent_tool_use_id: null,
      message: {
        id: 'msg-no-tool-input',
        model: 'claude-sonnet-4-5',
        content: [
          { type: 'tool_use', id: 'toolu_noinput', name: 'Bash' },
        ],
        usage: { input_tokens: 50, output_tokens: 20 },
      },
    }))

    assert.ok(event)
    assert.deepEqual(event.toolCalls[0].input, {})
  })
})

// ════════════════════════════════════════════════════════════════════════════════
//  SECTION 7 — Web Search & MCP Tool Calls
// ════════════════════════════════════════════════════════════════════════════════

describe('Edge: web search tool calls', () => {
  test('WebSearch tool_use block is extracted normally', () => {
    const { ingester } = createIngester()
    const event = ingester.ingest(raw({
      type: 'assistant',
      session_id: 'sess-1',
      parent_tool_use_id: null,
      message: {
        id: 'msg-websearch',
        model: 'claude-sonnet-4-5',
        content: [
          { type: 'text', text: 'Let me search for that.' },
          {
            type: 'tool_use',
            id: 'toolu_ws_01',
            name: 'WebSearch',
            input: { query: 'Claude Agent SDK documentation' },
          },
        ],
        usage: { input_tokens: 200, output_tokens: 80 },
      },
    }))

    assert.ok(event)
    assert.equal(event.toolCalls.length, 1)
    assert.equal(event.toolCalls[0].toolName, 'WebSearch')
    assert.deepEqual(event.toolCalls[0].input, { query: 'Claude Agent SDK documentation' })
  })

  test('server_tool_use (web_search) is NOT extracted as a tool call', () => {
    // server_tool_use is a different content block type from tool_use
    const { ingester } = createIngester()
    const event = ingester.ingest(raw({
      type: 'assistant',
      session_id: 'sess-1',
      parent_tool_use_id: null,
      message: {
        id: 'msg-server-ws',
        model: 'claude-sonnet-4-5',
        content: [
          { type: 'server_tool_use', id: 'srvtoolu_01', name: 'web_search', input: { query: 'test' } },
          { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_01', content: [
            { type: 'web_search_result', url: 'https://example.com', title: 'Example', encrypted_content: 'enc', page_age: '2d' },
          ]},
          { type: 'text', text: 'Based on my search results...' },
        ],
        usage: { input_tokens: 500, output_tokens: 300 },
      },
    }))

    assert.ok(event)
    assert.equal(event.toolCalls.length, 0, 'server_tool_use should not appear in toolCalls')
  })
})

describe('Edge: MCP namespaced tool calls', () => {
  test('MCP tool with double-underscore namespace is extracted with full name', () => {
    const { ingester } = createIngester()
    const event = ingester.ingest(raw({
      type: 'assistant',
      session_id: 'sess-1',
      parent_tool_use_id: null,
      message: {
        id: 'msg-mcp-tool',
        model: 'claude-sonnet-4-5',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_mcp_01',
            name: 'mcp__filesystem__read_file',
            input: { path: '/workspace/data.json' },
          },
        ],
        usage: { input_tokens: 150, output_tokens: 40 },
      },
    }))

    assert.ok(event)
    assert.equal(event.toolCalls.length, 1)
    assert.equal(event.toolCalls[0].toolName, 'mcp__filesystem__read_file')
    assert.equal(event.toolCalls[0].toolId, 'toolu_mcp_01')
  })

  test('multiple MCP tools from different servers in one message', () => {
    const { ingester } = createIngester()
    const event = ingester.ingest(raw({
      type: 'assistant',
      session_id: 'sess-1',
      parent_tool_use_id: null,
      message: {
        id: 'msg-multi-mcp',
        model: 'claude-sonnet-4-5',
        content: [
          { type: 'tool_use', id: 'toolu_mcp_a', name: 'mcp__database__query', input: { sql: 'SELECT 1' } },
          { type: 'tool_use', id: 'toolu_mcp_b', name: 'mcp__weather__get_forecast', input: { city: 'SF' } },
          { type: 'tool_use', id: 'toolu_mcp_c', name: 'mcp__calculator__add', input: { a: 1, b: 2 } },
        ],
        usage: { input_tokens: 300, output_tokens: 100 },
      },
    }))

    assert.ok(event)
    assert.equal(event.toolCalls.length, 3)
    assert.equal(event.toolCalls[0].toolName, 'mcp__database__query')
    assert.equal(event.toolCalls[1].toolName, 'mcp__weather__get_forecast')
    assert.equal(event.toolCalls[2].toolName, 'mcp__calculator__add')
  })
})

// ════════════════════════════════════════════════════════════════════════════════
//  SECTION 8 — Messages Without session_id
// ════════════════════════════════════════════════════════════════════════════════

describe('Edge: messages without session_id', () => {
  test('system init without session_id uses empty string', () => {
    const { ingester } = createIngester()
    const event = ingester.ingest(raw({
      type: 'system',
      subtype: 'init',
      model: 'claude-sonnet-4-5',
      // no session_id
    }))

    assert.ok(event)
    assert.equal(event.sessionId, '')
    assert.equal(ingester.getSessionId(), null) // undefined sid doesn't set sessionId
  })

  test('assistant message without session_id uses empty string fallback', () => {
    const { ingester } = createIngester()
    const event = ingester.ingest(raw({
      type: 'assistant',
      parent_tool_use_id: null,
      // no session_id
      message: {
        id: 'msg-no-sess',
        model: 'claude-sonnet-4-5',
        content: [{ type: 'text', text: 'hi' }],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    }))

    assert.ok(event)
    assert.equal(event.sessionId, '')
  })

  test('session_id is captured from the first message that has one', () => {
    const { ingester } = createIngester()
    // First message has no session_id
    ingester.ingest(raw({
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        id: 'msg-no-sess-1',
        model: 'claude-sonnet-4-5',
        content: [],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    }))
    assert.equal(ingester.getSessionId(), null)

    // Second message has session_id
    ingester.ingest(raw({
      type: 'assistant',
      session_id: 'sess-late',
      parent_tool_use_id: null,
      message: {
        id: 'msg-has-sess',
        model: 'claude-sonnet-4-5',
        content: [],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    }))
    assert.equal(ingester.getSessionId(), 'sess-late')
  })
})

// ════════════════════════════════════════════════════════════════════════════════
//  SECTION 9 — Messages Without message.id (Deduplication)
// ════════════════════════════════════════════════════════════════════════════════

describe('Edge: messages without message.id', () => {
  test('assistant message without message.id is still processed', () => {
    const { ingester } = createIngester()
    const event = ingester.ingest(raw({
      type: 'assistant',
      session_id: 'sess-1',
      parent_tool_use_id: null,
      message: {
        // no id field
        model: 'claude-sonnet-4-5',
        content: [{ type: 'text', text: 'no id here' }],
        usage: { input_tokens: 20, output_tokens: 10 },
      },
    }))

    assert.ok(event, 'message without id should still produce an event')
    assert.equal(event.messageId, null)
    assert.equal(event.usage!.inputTokens, 20)
  })

  test('multiple messages without id are NOT deduplicated (each produces an event)', () => {
    const { ingester } = createIngester()

    const event1 = ingester.ingest(raw({
      type: 'assistant',
      session_id: 'sess-1',
      parent_tool_use_id: null,
      message: {
        model: 'claude-sonnet-4-5',
        content: [{ type: 'text', text: 'first' }],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    }))

    const event2 = ingester.ingest(raw({
      type: 'assistant',
      session_id: 'sess-1',
      parent_tool_use_id: null,
      message: {
        model: 'claude-sonnet-4-5',
        content: [{ type: 'text', text: 'second' }],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    }))

    assert.ok(event1)
    assert.ok(event2, 'second message without id should NOT be deduplicated')
    assert.notEqual(event1.eventId, event2.eventId)
  })

  test('message with undefined id is not added to seen set', () => {
    const { ingester } = createIngester()

    // Message without id
    ingester.ingest(raw({
      type: 'assistant',
      session_id: 'sess-1',
      parent_tool_use_id: null,
      message: {
        model: 'claude-sonnet-4-5',
        content: [],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    }))

    // Message with id should still be accepted
    const event = ingester.ingest(raw({
      type: 'assistant',
      session_id: 'sess-1',
      parent_tool_use_id: null,
      message: {
        id: 'msg-after-noid',
        model: 'claude-sonnet-4-5',
        content: [],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    }))

    assert.ok(event)
    assert.equal(event.messageId, 'msg-after-noid')
  })
})

// ════════════════════════════════════════════════════════════════════════════════
//  SECTION 10 — Result Messages with All Error Subtypes
// ════════════════════════════════════════════════════════════════════════════════

describe('Edge: result message error subtypes', () => {
  const errorSubtypes = [
    'error_max_turns',
    'error_during_execution',
    'error_max_budget_usd',
    'error_max_structured_output_retries',
  ]

  for (const subtype of errorSubtypes) {
    test(`result with subtype "${subtype}" is ingested correctly`, () => {
      const { ingester } = createIngester()
      const event = ingester.ingest(raw({
        type: 'result',
        subtype,
        uuid: `uuid-${subtype}`,
        session_id: 'sess-1',
        duration_ms: 30000,
        duration_api_ms: 25000,
        is_error: true,
        num_turns: 5,
        total_cost_usd: 0.42,
        usage: { input_tokens: 5000, output_tokens: 1000 },
        modelUsage: {},
        permission_denials: [],
        errors: [`Error for ${subtype}`],
      }))

      assert.ok(event)
      assert.equal(event.type, 'result')
      assert.equal(event.subtype, subtype)
      assert.equal(event.costUsd, 0.42)
    })
  }

  test('result with missing subtype defaults to "unknown"', () => {
    const { ingester } = createIngester()
    const event = ingester.ingest(raw({
      type: 'result',
      // no subtype
      session_id: 'sess-1',
      total_cost_usd: 0.01,
    }))

    assert.ok(event)
    assert.equal(event.subtype, 'unknown')
  })

  test('result with missing total_cost_usd defaults to 0', () => {
    const { ingester } = createIngester()
    const event = ingester.ingest(raw({
      type: 'result',
      subtype: 'success',
      session_id: 'sess-1',
      // no total_cost_usd
    }))

    assert.ok(event)
    assert.equal(event.costUsd, 0)
  })

  test('result with total_cost_usd = null defaults to 0', () => {
    const { ingester } = createIngester()
    const event = ingester.ingest(raw({
      type: 'result',
      subtype: 'success',
      session_id: 'sess-1',
      total_cost_usd: null,
    }))

    assert.ok(event)
    assert.equal(event.costUsd, 0)
  })
})

// ════════════════════════════════════════════════════════════════════════════════
//  SECTION 11 — System Messages with Unknown Subtypes
// ════════════════════════════════════════════════════════════════════════════════

describe('Edge: system messages with unknown subtypes', () => {
  test('unknown system subtype returns null', () => {
    const { ingester } = createIngester()
    const event = ingester.ingest(raw({
      type: 'system',
      subtype: 'unknown_future_subtype',
      session_id: 'sess-1',
    }))

    assert.equal(event, null)
  })

  test('system subtype "status" returns null', () => {
    const { ingester } = createIngester()
    const event = ingester.ingest(raw({
      type: 'system',
      subtype: 'status',
      session_id: 'sess-1',
    }))

    assert.equal(event, null)
  })

  test('system message with no subtype returns null', () => {
    const { ingester } = createIngester()
    const event = ingester.ingest(raw({
      type: 'system',
      session_id: 'sess-1',
      // no subtype
    }))

    assert.equal(event, null)
  })

  test('system init without model field sets model to null', () => {
    const { ingester } = createIngester()
    const event = ingester.ingest(raw({
      type: 'system',
      subtype: 'init',
      session_id: 'sess-1',
      // no model field
    }))

    assert.ok(event)
    assert.equal(event.model, null)
    assert.equal(ingester.getModel(), null)
  })
})

// ════════════════════════════════════════════════════════════════════════════════
//  SECTION 12 — Model Fallback and Cost Calculation
// ════════════════════════════════════════════════════════════════════════════════

describe('Edge: model fallback and cost interaction', () => {
  test('assistant message model overrides the init model for cost calculation', () => {
    const { ingester } = createIngester()
    // Init with haiku
    ingester.ingest(raw({
      type: 'system',
      subtype: 'init',
      session_id: 'sess-1',
      model: 'claude-haiku-3-5',
    }))

    // Assistant message reports a different model (fallback/upgrade)
    const event = ingester.ingest(raw({
      type: 'assistant',
      session_id: 'sess-1',
      parent_tool_use_id: null,
      message: {
        id: 'msg-model-override',
        model: 'claude-sonnet-4-5',
        content: [{ type: 'text', text: 'I was upgraded' }],
        usage: {
          input_tokens: 1_000_000,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    }))

    assert.ok(event)
    assert.equal(event.model, 'claude-sonnet-4-5')
    // Cost should use sonnet pricing ($3/MTok), not haiku
    assert.equal(event.costUsd, 3.0)
  })

  test('assistant message without model falls back to init model', () => {
    const { ingester } = createIngester()
    ingester.ingest(raw({
      type: 'system',
      subtype: 'init',
      session_id: 'sess-1',
      model: 'claude-haiku-3-5',
    }))

    const event = ingester.ingest(raw({
      type: 'assistant',
      session_id: 'sess-1',
      parent_tool_use_id: null,
      message: {
        id: 'msg-no-model',
        // no model field in inner message
        content: [{ type: 'text', text: 'Using fallback model' }],
        usage: {
          input_tokens: 1_000_000,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    }))

    assert.ok(event)
    assert.equal(event.model, 'claude-haiku-3-5')
    // Cost should use haiku pricing ($0.80/MTok)
    assert.equal(event.costUsd, 0.80)
  })

  test('cost is zero when neither init nor message specifies a model', () => {
    const { ingester } = createIngester()
    // No init message, so no model set

    const event = ingester.ingest(raw({
      type: 'assistant',
      session_id: 'sess-1',
      parent_tool_use_id: null,
      message: {
        id: 'msg-truly-no-model',
        // no model
        content: [],
        usage: {
          input_tokens: 1_000_000,
          output_tokens: 1_000_000,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    }))

    assert.ok(event)
    assert.equal(event.model, null)
    assert.equal(event.costUsd, 0, 'no model should yield zero cost')
  })

  test('unknown model yields zero cost even with large usage', () => {
    const { ingester } = createIngester()
    const event = ingester.ingest(raw({
      type: 'assistant',
      session_id: 'sess-1',
      parent_tool_use_id: null,
      message: {
        id: 'msg-unknown-model',
        model: 'claude-mega-9000',
        content: [],
        usage: {
          input_tokens: 10_000_000,
          output_tokens: 10_000_000,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    }))

    assert.ok(event)
    assert.equal(event.costUsd, 0)
  })
})

// ════════════════════════════════════════════════════════════════════════════════
//  SECTION 13 — Processing After reset()
// ════════════════════════════════════════════════════════════════════════════════

describe('Edge: ingester reset() behavior', () => {
  test('reset clears deduplication — same message ID accepted again', () => {
    const { ingester } = createIngester()
    ingester.ingest(raw({
      type: 'assistant',
      session_id: 'sess-1',
      parent_tool_use_id: null,
      message: {
        id: 'msg-reuse',
        model: 'claude-sonnet-4-5',
        content: [],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    }))

    ingester.reset()

    const event = ingester.ingest(raw({
      type: 'assistant',
      session_id: 'sess-2',
      parent_tool_use_id: null,
      message: {
        id: 'msg-reuse',  // same ID
        model: 'claude-sonnet-4-5',
        content: [],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    }))

    assert.ok(event, 'after reset, previously-seen message ID should be accepted')
  })

  test('reset clears model — subsequent messages without model report null', () => {
    const { ingester } = createIngester()
    ingester.ingest(raw({
      type: 'system',
      subtype: 'init',
      session_id: 'sess-1',
      model: 'claude-sonnet-4-5',
    }))
    assert.equal(ingester.getModel(), 'claude-sonnet-4-5')

    ingester.reset()
    assert.equal(ingester.getModel(), null)

    const event = ingester.ingest(raw({
      type: 'assistant',
      session_id: 'sess-2',
      parent_tool_use_id: null,
      message: {
        id: 'msg-post-reset',
        // no model in inner message
        content: [],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    }))

    assert.ok(event)
    assert.equal(event.model, null)
    assert.equal(event.costUsd, 0) // null model → zero cost
  })

  test('reset clears session ID', () => {
    const { ingester } = createIngester()
    ingester.ingest(raw({
      type: 'system',
      subtype: 'init',
      session_id: 'sess-old',
      model: 'claude-sonnet-4-5',
    }))
    assert.equal(ingester.getSessionId(), 'sess-old')

    ingester.reset()
    assert.equal(ingester.getSessionId(), null)

    ingester.ingest(raw({
      type: 'system',
      subtype: 'init',
      session_id: 'sess-new',
      model: 'claude-sonnet-4-5',
    }))
    assert.equal(ingester.getSessionId(), 'sess-new')
  })

  test('reset resets event ID counter', () => {
    const { ingester } = createIngester()
    const e1 = ingester.ingest(raw({
      type: 'user',
      session_id: 'sess-1',
      parent_tool_use_id: null,
      message: { role: 'user', content: [] },
    }))
    assert.ok(e1)
    assert.equal(e1.eventId, 'evt_0')

    const e2 = ingester.ingest(raw({
      type: 'user',
      session_id: 'sess-1',
      parent_tool_use_id: null,
      message: { role: 'user', content: [] },
    }))
    assert.ok(e2)
    assert.equal(e2.eventId, 'evt_1')

    ingester.reset()

    const e3 = ingester.ingest(raw({
      type: 'user',
      session_id: 'sess-2',
      parent_tool_use_id: null,
      message: { role: 'user', content: [] },
    }))
    assert.ok(e3)
    assert.equal(e3.eventId, 'evt_0', 'event counter should reset to 0')
  })
})

// ════════════════════════════════════════════════════════════════════════════════
//  SECTION 14 — CostCalculator with Empty Pricing Table
// ════════════════════════════════════════════════════════════════════════════════

describe('Edge: CostCalculator with empty custom pricing', () => {
  test('empty pricing table still falls back to global PRICING for known models', () => {
    const calc = new CostCalculator({})
    const usage = makeUsage({ inputTokens: 1_000_000 })

    // These should all resolve via the global lookupPricing fallback
    const sonnetCost = calc.calculate(usage, 'claude-sonnet-4-5')
    assert.equal(sonnetCost, 3.0)

    const opusCost = calc.calculate(usage, 'claude-opus-4-5')
    assert.equal(opusCost, 5.0)

    const haikuCost = calc.calculate(usage, 'claude-haiku-3')
    assert.equal(haikuCost, 0.25)
  })

  test('empty pricing + unknown model returns 0', () => {
    const calc = new CostCalculator({})
    const usage = makeUsage({ inputTokens: 1_000_000 })
    assert.equal(calc.calculate(usage, 'gpt-4o'), 0)
  })

  test('completely isolated pricing (no global fallback for unknown models)', () => {
    const isolatedPricing: Record<string, PricingEntry> = {
      'my-model': {
        inputPerMTok: 1.0,
        outputPerMTok: 2.0,
        cacheWrite5mPerMTok: 1.5,
        cacheWrite1hPerMTok: 2.0,
        cacheReadPerMTok: 0.1,
      },
    }
    const calc = new CostCalculator(isolatedPricing)
    const usage = makeUsage({ inputTokens: 1_000_000 })

    assert.equal(calc.calculate(usage, 'my-model'), 1.0)
    // Global model should still work via lookupPricing fallback
    assert.equal(calc.calculate(usage, 'claude-sonnet-4-5'), 3.0)
  })
})

// ════════════════════════════════════════════════════════════════════════════════
//  SECTION 15 — Pricing lookupPricing Edge Cases
// ════════════════════════════════════════════════════════════════════════════════

describe('Edge: lookupPricing', () => {
  test('exact match takes priority', () => {
    const entry = lookupPricing('claude-sonnet-4-5')
    assert.ok(entry)
    assert.equal(entry.inputPerMTok, 3.0)
  })

  test('date-suffixed model resolves to base model', () => {
    const entry = lookupPricing('claude-sonnet-4-5-20250929')
    assert.ok(entry)
    assert.equal(entry.inputPerMTok, 3.0)
  })

  test('date-suffixed opus resolves correctly', () => {
    const entry = lookupPricing('claude-opus-4-6-20260101')
    assert.ok(entry)
    assert.equal(entry.inputPerMTok, 5.0)
  })

  test('completely unknown model returns null', () => {
    const entry = lookupPricing('gpt-4o')
    assert.equal(entry, null)
  })

  test('partial model name that does not match returns null', () => {
    const entry = lookupPricing('claude-sonnet')
    assert.equal(entry, null)
  })

  test('model with non-date numeric suffix does not resolve', () => {
    // "-123" is only 3 digits, not 8 — regex requires exactly 8 digits
    const entry = lookupPricing('claude-sonnet-4-5-123')
    assert.equal(entry, null)
  })

  test('model with extra segments after date does not resolve', () => {
    // "-20250929-beta" — date is not at the end
    const entry = lookupPricing('claude-sonnet-4-5-20250929-beta')
    assert.equal(entry, null)
  })

  test('empty string returns null', () => {
    const entry = lookupPricing('')
    assert.equal(entry, null)
  })

  test('all models in pricing table are resolvable', () => {
    for (const modelId of Object.keys(PRICING)) {
      const entry = lookupPricing(modelId)
      assert.ok(entry, `${modelId} should be resolvable`)
    }
  })
})

// ════════════════════════════════════════════════════════════════════════════════
//  SECTION 16 — Skipped / Unknown Message Types
// ════════════════════════════════════════════════════════════════════════════════

describe('Edge: skipped and unknown message types', () => {
  test('stream_event is skipped', () => {
    const { ingester } = createIngester()
    const event = ingester.ingest(raw({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
      parent_tool_use_id: null,
      uuid: 'uuid-stream',
      session_id: 'sess-1',
    }))
    assert.equal(event, null)
  })

  test('hook_started is skipped', () => {
    const { ingester } = createIngester()
    const event = ingester.ingest(raw({
      type: 'hook_started',
      hook: 'PreToolUse',
      session_id: 'sess-1',
    }))
    assert.equal(event, null)
  })

  test('tool_progress is skipped', () => {
    const { ingester } = createIngester()
    const event = ingester.ingest(raw({
      type: 'tool_progress',
      tool_use_id: 'toolu_01',
      progress: 50,
      session_id: 'sess-1',
    }))
    assert.equal(event, null)
  })

  test('auth_status is skipped', () => {
    const { ingester } = createIngester()
    const event = ingester.ingest(raw({
      type: 'auth_status',
      status: 'authenticated',
      session_id: 'sess-1',
    }))
    assert.equal(event, null)
  })

  test('completely empty object returns null', () => {
    const { ingester } = createIngester()
    const event = ingester.ingest(raw({}))
    assert.equal(event, null)
  })

  test('object with type: undefined returns null', () => {
    const { ingester } = createIngester()
    const event = ingester.ingest(raw({ type: undefined }))
    assert.equal(event, null)
  })

  test('object with type: null returns null', () => {
    const { ingester } = createIngester()
    const event = ingester.ingest(raw({ type: null }))
    assert.equal(event, null)
  })
})

// ════════════════════════════════════════════════════════════════════════════════
//  SECTION 17 — CostCalculator Running Total Edge Cases
// ════════════════════════════════════════════════════════════════════════════════

describe('Edge: CostCalculator running total edge cases', () => {
  test('updateRunningTotal with unknown model adds tokens but zero cost', () => {
    const calc = new CostCalculator(exactPricing)
    calc.updateRunningTotal(makeUsage({ inputTokens: 1000, outputTokens: 500 }), 'nonexistent-model')

    const running = calc.getRunningCost()
    assert.equal(running.totalInputTokens, 1000)
    assert.equal(running.totalOutputTokens, 500)
    assert.equal(running.totalCostUsd, 0)
    assert.equal(running.messageCount, 1)
  })

  test('updateRunningTotal with null model adds tokens but zero cost', () => {
    const calc = new CostCalculator(exactPricing)
    calc.updateRunningTotal(makeUsage({ inputTokens: 100 }), null)

    const running = calc.getRunningCost()
    assert.equal(running.totalInputTokens, 100)
    assert.equal(running.totalCostUsd, 0)
    assert.equal(running.messageCount, 1)
  })

  test('mixed known and unknown model messages accumulate correctly', () => {
    const calc = new CostCalculator(exactPricing)

    // Known model
    calc.updateRunningTotal(makeUsage({ inputTokens: 1_000_000 }), 'exact-model')
    // Unknown model
    calc.updateRunningTotal(makeUsage({ inputTokens: 500_000 }), 'unknown-model')
    // Known model again
    calc.updateRunningTotal(makeUsage({ outputTokens: 1_000_000 }), 'exact-model')

    const running = calc.getRunningCost()
    assert.equal(running.totalInputTokens, 1_500_000)
    assert.equal(running.totalOutputTokens, 1_000_000)
    assert.equal(running.messageCount, 3)
    // 10 + 0 + 20 = 30
    assert.equal(running.totalCostUsd, 30.0)
  })

  test('reset then re-accumulate starts fresh', () => {
    const calc = new CostCalculator(exactPricing)
    calc.updateRunningTotal(makeUsage({ inputTokens: 1_000_000 }), 'exact-model')
    assert.equal(calc.getRunningCost().totalCostUsd, 10.0)

    calc.reset()
    assert.equal(calc.getRunningCost().totalCostUsd, 0)
    assert.equal(calc.getRunningCost().messageCount, 0)

    calc.updateRunningTotal(makeUsage({ outputTokens: 1_000_000 }), 'exact-model')
    assert.equal(calc.getRunningCost().totalCostUsd, 20.0)
    assert.equal(calc.getRunningCost().messageCount, 1)
  })
})

// ════════════════════════════════════════════════════════════════════════════════
//  SECTION 18 — Full Ingestion Pipelines (Integration-Style)
// ════════════════════════════════════════════════════════════════════════════════

describe('Edge: full pipeline scenarios', () => {
  test('complete session: init → assistant (thinking) → user → assistant (tool) → result', () => {
    const { ingester } = createIngester()

    const e1 = ingester.ingest(raw({
      type: 'system',
      subtype: 'init',
      session_id: 'sess-full',
      model: 'claude-sonnet-4-5',
    }))
    assert.ok(e1)
    assert.equal(e1.type, 'system')

    const e2 = ingester.ingest(raw({
      type: 'assistant',
      session_id: 'sess-full',
      parent_tool_use_id: null,
      message: {
        id: 'msg-with-thinking',
        model: 'claude-sonnet-4-5',
        content: [
          { type: 'thinking', thinking: 'Let me think...', signature: 'sig' },
          { type: 'text', text: 'I will read the file.' },
          { type: 'tool_use', id: 'toolu_pipeline', name: 'Read', input: { file_path: '/x.ts' } },
        ],
        stop_reason: 'tool_use',
        usage: {
          input_tokens: 500,
          output_tokens: 100,
          cache_creation_input_tokens: 200,
          cache_read_input_tokens: 0,
        },
      },
    }))
    assert.ok(e2)
    assert.equal(e2.toolCalls.length, 1)
    assert.ok(e2.costUsd > 0)

    const e3 = ingester.ingest(raw({
      type: 'user',
      session_id: 'sess-full',
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_pipeline', content: 'file contents' }],
      },
    }))
    assert.ok(e3)
    assert.equal(e3.type, 'user')

    const e4 = ingester.ingest(raw({
      type: 'assistant',
      session_id: 'sess-full',
      parent_tool_use_id: null,
      message: {
        id: 'msg-final-answer',
        model: 'claude-sonnet-4-5',
        content: [{ type: 'text', text: 'Here is your answer.' }],
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 800,
          output_tokens: 200,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 500,
        },
      },
    }))
    assert.ok(e4)
    assert.equal(e4.toolCalls.length, 0)
    assert.ok(e4.costUsd > 0)

    const e5 = ingester.ingest(raw({
      type: 'result',
      subtype: 'success',
      session_id: 'sess-full',
      total_cost_usd: 0.05,
    }))
    assert.ok(e5)
    assert.equal(e5.type, 'result')
    assert.equal(e5.costUsd, 0.05)
  })

  test('session with compact boundary mid-stream', () => {
    const { ingester } = createIngester()

    ingester.ingest(raw({
      type: 'system',
      subtype: 'init',
      session_id: 'sess-compact',
      model: 'claude-sonnet-4-5',
    }))

    ingester.ingest(raw({
      type: 'assistant',
      session_id: 'sess-compact',
      parent_tool_use_id: null,
      message: {
        id: 'msg-pre-compact',
        model: 'claude-sonnet-4-5',
        content: [{ type: 'text', text: 'Working...' }],
        usage: { input_tokens: 100, output_tokens: 50 },
      },
    }))

    const compactEvent = ingester.ingest(raw({
      type: 'system',
      subtype: 'compact_boundary',
      session_id: 'sess-compact',
      compact_metadata: { trigger: 'auto', pre_tokens: 180000 },
    }))
    assert.ok(compactEvent)
    assert.equal(compactEvent.type, 'system')
    assert.equal(compactEvent.subtype, 'compact_boundary')

    // Messages after compaction should still work (model is preserved)
    const postCompact = ingester.ingest(raw({
      type: 'assistant',
      session_id: 'sess-compact',
      parent_tool_use_id: null,
      message: {
        id: 'msg-post-compact',
        model: 'claude-sonnet-4-5',
        content: [{ type: 'text', text: 'Continuing after compaction.' }],
        usage: { input_tokens: 5000, output_tokens: 200 },
      },
    }))
    assert.ok(postCompact)
    assert.equal(postCompact.model, 'claude-sonnet-4-5')
  })

  test('subagent messages with parentToolUseId', () => {
    const { ingester } = createIngester()
    ingester.ingest(raw({
      type: 'system',
      subtype: 'init',
      session_id: 'sess-sub',
      model: 'claude-sonnet-4-5',
    }))

    // Main agent calls a tool
    const mainMsg = ingester.ingest(raw({
      type: 'assistant',
      session_id: 'sess-sub',
      parent_tool_use_id: null,
      message: {
        id: 'msg-main',
        model: 'claude-sonnet-4-5',
        content: [
          { type: 'text', text: 'Delegating to subagent.' },
          { type: 'tool_use', id: 'toolu_subagent', name: 'Task', input: { prompt: 'do stuff' } },
        ],
        usage: { input_tokens: 300, output_tokens: 100 },
      },
    }))
    assert.ok(mainMsg)
    assert.equal(mainMsg.parentToolUseId, null)

    // Subagent response references the parent tool use
    const subMsg = ingester.ingest(raw({
      type: 'assistant',
      session_id: 'sess-sub',
      parent_tool_use_id: 'toolu_subagent',
      message: {
        id: 'msg-sub-response',
        model: 'claude-haiku-4-5',
        content: [{ type: 'text', text: 'Subagent result' }],
        usage: { input_tokens: 200, output_tokens: 80 },
      },
    }))
    assert.ok(subMsg)
    assert.equal(subMsg.parentToolUseId, 'toolu_subagent')
    assert.equal(subMsg.model, 'claude-haiku-4-5')
    // Cost uses haiku pricing, not sonnet
    const haikuPricing = lookupPricing('claude-haiku-4-5')
    assert.ok(haikuPricing)
    const expectedCost =
      (200 / 1_000_000) * haikuPricing.inputPerMTok +
      (80 / 1_000_000) * haikuPricing.outputPerMTok
    assert.ok(
      Math.abs(subMsg.costUsd - expectedCost) < 1e-10,
      `expected ~${expectedCost}, got ${subMsg.costUsd}`,
    )
  })
})

// ════════════════════════════════════════════════════════════════════════════════
//  SECTION 19 — Cost Calculation Across All Pricing Table Models
// ════════════════════════════════════════════════════════════════════════════════

describe('Edge: cost calculation for every model in pricing table', () => {
  for (const [modelId, entry] of Object.entries(PRICING)) {
    test(`${modelId}: 1M input tokens costs $${entry.inputPerMTok}`, () => {
      const calc = new CostCalculator()
      const cost = calc.calculate(makeUsage({ inputTokens: 1_000_000 }), modelId)
      assert.equal(cost, entry.inputPerMTok)
    })

    test(`${modelId}: 1M output tokens costs $${entry.outputPerMTok}`, () => {
      const calc = new CostCalculator()
      const cost = calc.calculate(makeUsage({ outputTokens: 1_000_000 }), modelId)
      assert.equal(cost, entry.outputPerMTok)
    })
  }
})

// ════════════════════════════════════════════════════════════════════════════════
//  SECTION 20 — Miscellaneous Edge Cases
// ════════════════════════════════════════════════════════════════════════════════

describe('Edge: miscellaneous', () => {
  test('user message has no usage field (always null)', () => {
    const { ingester } = createIngester()
    const event = ingester.ingest(raw({
      type: 'user',
      session_id: 'sess-1',
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'hello' }],
      },
    }))

    assert.ok(event)
    assert.equal(event.usage, null)
    assert.equal(event.costUsd, 0)
    assert.equal(event.toolCalls.length, 0)
  })

  test('user message captures parentToolUseId', () => {
    const { ingester } = createIngester()
    const event = ingester.ingest(raw({
      type: 'user',
      session_id: 'sess-1',
      parent_tool_use_id: 'toolu_parent',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_parent', content: 'result' }],
      },
    }))

    assert.ok(event)
    assert.equal(event.parentToolUseId, 'toolu_parent')
  })

  test('deduplication works across different content block shapes', () => {
    const { ingester } = createIngester()

    // First message with text content
    const first = ingester.ingest(raw({
      type: 'assistant',
      session_id: 'sess-1',
      parent_tool_use_id: null,
      message: {
        id: 'msg-dup-shape',
        model: 'claude-sonnet-4-5',
        content: [{ type: 'text', text: 'first' }],
        usage: { input_tokens: 100, output_tokens: 50 },
      },
    }))

    // Second message with same ID but different content (tool_use)
    const second = ingester.ingest(raw({
      type: 'assistant',
      session_id: 'sess-1',
      parent_tool_use_id: null,
      message: {
        id: 'msg-dup-shape',
        model: 'claude-sonnet-4-5',
        content: [{ type: 'tool_use', id: 'toolu_x', name: 'Bash', input: {} }],
        usage: { input_tokens: 100, output_tokens: 50 },
      },
    }))

    assert.ok(first)
    assert.equal(second, null, 'same message ID with different content should still be deduplicated')
  })

  test('event timestamps are positive numbers', () => {
    const { ingester } = createIngester()
    const event = ingester.ingest(raw({
      type: 'user',
      session_id: 'sess-1',
      parent_tool_use_id: null,
      message: { role: 'user', content: [] },
    }))

    assert.ok(event)
    assert.ok(event.timestamp > 0, 'timestamp should be a positive number')
    assert.ok(Number.isFinite(event.timestamp), 'timestamp should be finite')
  })

  test('event IDs follow evt_N pattern', () => {
    const { ingester } = createIngester()

    for (let i = 0; i < 5; i++) {
      const event = ingester.ingest(raw({
        type: 'user',
        session_id: 'sess-1',
        parent_tool_use_id: null,
        message: { role: 'user', content: [] },
      }))
      assert.ok(event)
      assert.match(event.eventId, /^evt_\d+$/)
      assert.equal(event.eventId, `evt_${i}`)
    }
  })

  test('CostCalculator.getRunningCost returns a defensive copy', () => {
    const calc = new CostCalculator(exactPricing)
    const snapshot = calc.getRunningCost()

    // Mutate the snapshot
    snapshot.totalCostUsd = 999
    snapshot.totalInputTokens = 999
    snapshot.messageCount = 999

    // Original should be unchanged
    const fresh = calc.getRunningCost()
    assert.equal(fresh.totalCostUsd, 0)
    assert.equal(fresh.totalInputTokens, 0)
    assert.equal(fresh.messageCount, 0)
  })

  test('cost calculation with only cache tokens (no base input/output)', () => {
    const calc = new CostCalculator(exactPricing)
    const usage = makeUsage({
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 1_000_000,
      cacheReadInputTokens: 2_000_000,
    })
    const cost = calc.calculate(usage, 'exact-model')
    // cache write: (1M/1M) * 12.5 = 12.5
    // cache read:  (2M/1M) * 1.0  = 2.0
    assert.equal(cost, 14.5)
  })

  test('result message preserves session model even though result has no inner message', () => {
    const { ingester } = createIngester()
    ingester.ingest(raw({
      type: 'system',
      subtype: 'init',
      session_id: 'sess-1',
      model: 'claude-opus-4-6',
    }))

    const result = ingester.ingest(raw({
      type: 'result',
      subtype: 'success',
      session_id: 'sess-1',
      total_cost_usd: 1.23,
    }))

    assert.ok(result)
    assert.equal(result.model, 'claude-opus-4-6', 'result should inherit model from init')
  })
})
