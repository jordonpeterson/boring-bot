/**
 * Local dev server — runs query() in-process with access to your real repo.
 * No Docker required. Same SSE API as the Docker-backed server.
 *
 *   ANTHROPIC_API_KEY=sk-...        pnpm serve
 *   CLAUDE_CODE_OAUTH_TOKEN=<tok>   pnpm serve
 *
 * Override the working directory Claude sees:
 *   CWD=/path/to/your/project pnpm serve
 */
import Fastify from 'fastify'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { randomUUID } from 'node:crypto'
import { getCredentials } from './credentials.js'
import type { ExecuteOptions, StreamEvent } from '@boring-bot/code-executor'

// Set credentials in process.env before the first query() call.
// The SDK reads ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN from process.env.
const creds = await getCredentials()
if (creds.type === 'api_key') {
  process.env['ANTHROPIC_API_KEY'] = creds.value
} else {
  process.env['CLAUDE_CODE_OAUTH_TOKEN'] = creds.value
}

const AUTH_TOKEN = process.env['AUTH_TOKEN'] ?? 'dev-token'
const CWD        = process.env['CWD']        ?? process.cwd()
const PORT       = Number(process.env['PORT'] ?? 3001)

const app = Fastify({ logger: false })

app.addHook('onRequest', async (request, reply) => {
  if (request.headers['authorization'] !== `Bearer ${AUTH_TOKEN}`) {
    await reply.code(401).send({ error: 'Unauthorized' })
  }
})

app.post<{ Body: ExecuteOptions }>('/run', async (request, reply) => {
  const options = request.body
  const runId = randomUUID()

  reply.raw.writeHead(200, {
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive',
    'X-Run-Id':      runId,
  })

  function send(ev: StreamEvent): void {
    reply.raw.write(`data: ${JSON.stringify(ev)}\n\n`)
  }

  try {
    let seq = 0
    for await (const event of query({
      prompt: options.prompt,
      options: {
        cwd:            CWD,
        allowedTools:   options.allowedTools,
        maxTurns:       options.maxTurns,
        permissionMode: options.permissionMode,
        resume:         options.resume,
      },
    })) {
      send({ type: 'event', runId, seq: seq++, ts: Date.now(), event })
    }
    send({ type: 'done', runId, exitCode: 0, logPath: '', agentDir: CWD })
  } catch (err) {
    send({ type: 'error', runId, text: String(err) })
  } finally {
    reply.raw.end()
  }
})

await app.listen({ host: '0.0.0.0', port: PORT })
console.log(`Local runner  http://localhost:${PORT}`)
console.log(`cwd           ${CWD}`)
console.log(`auth          Bearer ${AUTH_TOKEN}`)
