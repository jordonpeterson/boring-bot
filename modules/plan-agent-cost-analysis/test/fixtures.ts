/**
 * Shared test fixtures for plan-agent-cost-analysis tests.
 *
 * We cast minimal objects to SDKMessage since the real type is a large
 * opaque union from the SDK.  Tests focus on our analysis logic, not SDK types.
 */
import type { SDKMessage, StreamEvent } from '@boring-bot/code-executor'

// ─── Factory helpers ────────────────────────────────────────────────────────

export function makeSystemInit(overrides: Record<string, unknown> = {}): SDKMessage {
  return {
    type: 'system',
    subtype: 'init',
    uuid: 'uuid-sys-init',
    session_id: 'sess-1',
    model: 'claude-sonnet-4-5-20250929',
    tools: ['Read', 'Write', 'Bash', 'Edit'],
    mcp_servers: [],
    apiKeySource: 'user',
    cwd: '/workspace',
    permissionMode: 'default',
    slash_commands: [],
    output_style: 'text',
    ...overrides,
  } as unknown as SDKMessage
}

export function makeCompactBoundary(preTokens = 150000): SDKMessage {
  return {
    type: 'system',
    subtype: 'compact_boundary',
    uuid: 'uuid-compact',
    session_id: 'sess-1',
    compact_metadata: { trigger: 'auto', pre_tokens: preTokens },
  } as unknown as SDKMessage
}

export function makeAssistantTextOnly(overrides: {
  messageId?: string
  inputTokens?: number
  outputTokens?: number
  cacheCreation?: number
  cacheRead?: number
  model?: string
  text?: string
  sessionId?: string
  parentToolUseId?: string | null
} = {}): SDKMessage {
  return {
    type: 'assistant',
    uuid: `uuid-asst-${overrides.messageId ?? 'msg-1'}`,
    session_id: overrides.sessionId ?? 'sess-1',
    parent_tool_use_id: overrides.parentToolUseId ?? null,
    message: {
      id: overrides.messageId ?? 'msg-1',
      type: 'message',
      role: 'assistant',
      content: [
        { type: 'text', text: overrides.text ?? 'Hello world' },
      ],
      model: overrides.model ?? 'claude-sonnet-4-5-20250929',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: overrides.inputTokens ?? 100,
        output_tokens: overrides.outputTokens ?? 50,
        cache_creation_input_tokens: overrides.cacheCreation ?? 0,
        cache_read_input_tokens: overrides.cacheRead ?? 0,
      },
    },
  } as unknown as SDKMessage
}

export function makeAssistantWithToolUse(overrides: {
  messageId?: string
  inputTokens?: number
  outputTokens?: number
  cacheCreation?: number
  cacheRead?: number
  model?: string
  toolName?: string
  toolId?: string
  toolInput?: Record<string, unknown>
  text?: string
  sessionId?: string
} = {}): SDKMessage {
  return {
    type: 'assistant',
    uuid: `uuid-asst-${overrides.messageId ?? 'msg-tool-1'}`,
    session_id: overrides.sessionId ?? 'sess-1',
    parent_tool_use_id: null,
    message: {
      id: overrides.messageId ?? 'msg-tool-1',
      type: 'message',
      role: 'assistant',
      content: [
        { type: 'text', text: overrides.text ?? 'Let me read the file.' },
        {
          type: 'tool_use',
          id: overrides.toolId ?? 'toolu_01abc',
          name: overrides.toolName ?? 'Read',
          input: overrides.toolInput ?? { file_path: '/workspace/file.ts' },
        },
      ],
      model: overrides.model ?? 'claude-sonnet-4-5-20250929',
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: {
        input_tokens: overrides.inputTokens ?? 200,
        output_tokens: overrides.outputTokens ?? 60,
        cache_creation_input_tokens: overrides.cacheCreation ?? 0,
        cache_read_input_tokens: overrides.cacheRead ?? 0,
      },
    },
  } as unknown as SDKMessage
}

export function makeAssistantMultiTool(overrides: {
  messageId?: string
  inputTokens?: number
  outputTokens?: number
  tools?: Array<{ name: string; id: string; input: Record<string, unknown> }>
} = {}): SDKMessage {
  const tools = overrides.tools ?? [
    { name: 'Read', id: 'toolu_01', input: { file_path: '/a.ts' } },
    { name: 'Bash', id: 'toolu_02', input: { command: 'ls' } },
  ]
  return {
    type: 'assistant',
    uuid: `uuid-asst-${overrides.messageId ?? 'msg-multi'}`,
    session_id: 'sess-1',
    parent_tool_use_id: null,
    message: {
      id: overrides.messageId ?? 'msg-multi',
      type: 'message',
      role: 'assistant',
      content: [
        { type: 'text', text: 'Multiple tools' },
        ...tools.map((t) => ({
          type: 'tool_use' as const,
          id: t.id,
          name: t.name,
          input: t.input,
        })),
      ],
      model: 'claude-sonnet-4-5-20250929',
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: {
        input_tokens: overrides.inputTokens ?? 300,
        output_tokens: overrides.outputTokens ?? 80,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  } as unknown as SDKMessage
}

export function makeUserMessage(overrides: {
  sessionId?: string
  toolResultId?: string
  content?: string
  isError?: boolean
} = {}): SDKMessage {
  return {
    type: 'user',
    session_id: overrides.sessionId ?? 'sess-1',
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: overrides.toolResultId ?? 'toolu_01abc',
          content: overrides.content ?? 'file contents here',
          is_error: overrides.isError ?? false,
        },
      ],
    },
  } as unknown as SDKMessage
}

export function makeResultSuccess(overrides: {
  totalCostUsd?: number
  numTurns?: number
  durationMs?: number
  durationApiMs?: number
  inputTokens?: number
  outputTokens?: number
  cacheCreation?: number
  cacheRead?: number
  result?: string
  sessionId?: string
  modelUsage?: Record<string, Record<string, unknown>>
  permissionDenials?: unknown[]
} = {}): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    uuid: 'uuid-result',
    session_id: overrides.sessionId ?? 'sess-1',
    duration_ms: overrides.durationMs ?? 15000,
    duration_api_ms: overrides.durationApiMs ?? 12000,
    is_error: false,
    num_turns: overrides.numTurns ?? 3,
    result: overrides.result ?? 'Task completed successfully.',
    total_cost_usd: overrides.totalCostUsd ?? 0.0234,
    usage: {
      input_tokens: overrides.inputTokens ?? 1500,
      output_tokens: overrides.outputTokens ?? 300,
      cache_creation_input_tokens: overrides.cacheCreation ?? 500,
      cache_read_input_tokens: overrides.cacheRead ?? 800,
    },
    modelUsage: overrides.modelUsage ?? {
      'claude-sonnet-4-5-20250929': {
        inputTokens: 1500,
        outputTokens: 300,
        cacheReadInputTokens: 800,
        cacheCreationInputTokens: 500,
        webSearchRequests: 0,
        costUSD: 0.0234,
        contextWindow: 200000,
      },
    },
    permission_denials: overrides.permissionDenials ?? [],
  } as unknown as SDKMessage
}

export function makeResultError(overrides: {
  subtype?: string
  totalCostUsd?: number
  numTurns?: number
  errors?: string[]
} = {}): SDKMessage {
  return {
    type: 'result',
    subtype: overrides.subtype ?? 'error_max_turns',
    uuid: 'uuid-result-err',
    session_id: 'sess-1',
    duration_ms: 60000,
    duration_api_ms: 55000,
    is_error: true,
    num_turns: overrides.numTurns ?? 10,
    total_cost_usd: overrides.totalCostUsd ?? 0.15,
    usage: {
      input_tokens: 8000,
      output_tokens: 2000,
      cache_creation_input_tokens: 1000,
      cache_read_input_tokens: 5000,
    },
    modelUsage: {},
    permission_denials: [],
    errors: overrides.errors ?? ['Maximum number of turns (10) exceeded'],
  } as unknown as SDKMessage
}

export function makeStreamEvent(): SDKMessage {
  return {
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
    parent_tool_use_id: null,
    uuid: 'uuid-stream',
    session_id: 'sess-1',
  } as unknown as SDKMessage
}

/** Wrap an SDKMessage as a code-executor StreamEvent. */
export function wrapAsStreamEvent(msg: SDKMessage, runId = 'run-1', seq = 0): StreamEvent {
  return { type: 'event', runId, seq, ts: Date.now(), event: msg }
}
