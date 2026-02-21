import type { ExecuteOptions, SDKMessage, StreamEvent } from '@boring-bot/code-executor'

// ─── ANSI helpers ────────────────────────────────────────────────────────────

const c = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  red:    '\x1b[31m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  cyan:   '\x1b[36m',
  gray:   '\x1b[90m',
} as const

function tag(label: string, color: string): string {
  return `${color}${c.bold}[${label}]${c.reset}`
}

// ─── Pretty-printer ──────────────────────────────────────────────────────────

/**
 * Write a human-readable representation of a StreamEvent to stdout.
 * Noisy low-signal events (stream_event partial chunks) are suppressed.
 */
export function prettyPrint(ev: StreamEvent): void {
  if (ev.type === 'error') {
    console.log(`${tag('error', c.red)} ${ev.text}`)
    return
  }

  if (ev.type === 'done') {
    const status = ev.exitCode === 0 ? c.green : c.red
    console.log(`\n${tag('done', status)} exit=${ev.exitCode}  log=${c.dim}${ev.logPath}${c.reset}`)
    return
  }

  // ev.type === 'event'
  const msg = ev.event as SDKMessage

  switch (msg.type) {
    case 'assistant': {
      const blocks = msg.message.content
      for (const block of blocks) {
        if (block.type === 'text' && block.text.trim()) {
          console.log(`\n${tag('assistant', c.green)}\n${block.text}`)
        } else if (block.type === 'tool_use') {
          const inputPreview = JSON.stringify(block.input).slice(0, 120)
          console.log(`${tag('tool', c.yellow)} ${c.bold}${block.name}${c.reset}  ${c.dim}${inputPreview}${c.reset}`)
        }
      }
      break
    }

    case 'result': {
      if (msg.subtype === 'success') {
        const cost = msg.total_cost_usd.toFixed(4)
        console.log(`\n${tag('result', c.cyan)} turns=${msg.num_turns}  cost=$${cost}`)
        if (msg.result.trim()) {
          console.log(msg.result)
        }
      } else {
        console.log(`${tag('result:error', c.red)} subtype=${msg.subtype}`)
      }
      break
    }

    case 'system': {
      if (msg.subtype === 'init') {
        console.log(
          `${tag('system', c.gray)} session=${msg.session_id}  model=${msg.model}  ` +
          `tools=${msg.tools.join(',')}`,
        )
      }
      // suppress compact_boundary / status / task_notification
      break
    }

    case 'stream_event':
      // High-frequency partial chunks — suppress to avoid noise
      break

    default: {
      // Catch-all for hook_started, tool_progress, auth_status, etc.
      const raw = JSON.stringify(msg).slice(0, 200)
      console.log(`${tag(msg.type, c.gray)} ${c.dim}${raw}${c.reset}`)
    }
  }
}

// ─── Client ──────────────────────────────────────────────────────────────────

export interface CodeExecutorClientConfig {
  url?: string       // default: http://localhost:3000
  authToken?: string // default: dev-token
}

export class CodeExecutorClient {
  private readonly url: string
  private readonly authToken: string

  constructor(config: CodeExecutorClientConfig = {}) {
    this.url = config.url ?? 'http://localhost:3000'
    this.authToken = config.authToken ?? 'dev-token'
  }

  /**
   * Trigger a run and stream back events as an AsyncGenerator.
   */
  async *run(options: ExecuteOptions): AsyncGenerator<StreamEvent> {
    const response = await fetch(`${this.url}/run`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.authToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(options),
    })

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`)
    }

    if (!response.body) {
      throw new Error('Response body is null')
    }

    yield* parseSseStream(response.body)
  }

  /**
   * Replay a completed run from its log file.
   */
  async *replay(runId: string, options?: { realtime?: boolean }): AsyncGenerator<StreamEvent> {
    const params = options?.realtime ? '?realtime=true' : ''
    const response = await fetch(`${this.url}/run/${runId}/replay${params}`, {
      headers: { 'Authorization': `Bearer ${this.authToken}` },
    })

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`)
    }

    if (!response.body) {
      throw new Error('Response body is null')
    }

    yield* parseSseStream(response.body)
  }
}

// ─── SSE parser ──────────────────────────────────────────────────────────────

async function* parseSseStream(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const json = line.slice(6).trim()
          if (json) yield JSON.parse(json) as StreamEvent
        }
      }
    }

    // Flush remaining buffer
    if (buffer.startsWith('data: ')) {
      const json = buffer.slice(6).trim()
      if (json) yield JSON.parse(json) as StreamEvent
    }
  } finally {
    reader.releaseLock()
  }
}
