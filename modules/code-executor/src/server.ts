import { join } from 'node:path'
import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify'
import { ExecutorService } from './executor.js'
import { replayRun } from './replay.js'
import type { ExecuteOptions, ServerConfig, StreamEvent } from './types.js'

export function createServer(config: ServerConfig): FastifyInstance {
  const app = Fastify({ logger: true })
  const executor = new ExecutorService(config)
  const logDir = config.logDir ?? '/tmp/boring-bot-logs'

  // Auth hook — send 401 and return so Fastify stops the lifecycle for this request.
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = request.headers['authorization']
    const expected = `Bearer ${config.authToken}`
    if (auth !== expected) {
      await reply.code(401).send({ error: 'Unauthorized' })
      return
    }
  })

  // POST /run
  app.post('/run', async (request: FastifyRequest, reply: FastifyReply) => {
    const options = request.body as ExecuteOptions
    let headersSent = false

    try {
      for await (const event of executor.execute(options)) {
        if (!headersSent) {
          reply.raw.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Run-Id': event.runId,
          })
          headersSent = true
        }
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`)
      }
    } catch (err) {
      const errorEvent: StreamEvent = { type: 'error', runId: '', text: String(err) }
      if (!headersSent) {
        reply.raw.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Run-Id': '',
        })
      }
      reply.raw.write(`data: ${JSON.stringify(errorEvent)}\n\n`)
    } finally {
      reply.raw.end()
    }
  })

  // GET /run/:runId/replay
  app.get('/run/:runId/replay', async (
    request: FastifyRequest<{ Params: { runId: string }; Querystring: { realtime?: string } }>,
    reply: FastifyReply,
  ) => {
    const { runId } = request.params
    const realtime = request.query.realtime === 'true'
    const logPath = join(logDir, `${runId}.ndjson`)

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Run-Id': runId,
    })

    try {
      for await (const event of replayRun(logPath, { realtime })) {
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`)
      }
    } catch (err) {
      const errorEvent: StreamEvent = { type: 'error', runId, text: String(err) }
      reply.raw.write(`data: ${JSON.stringify(errorEvent)}\n\n`)
    } finally {
      reply.raw.end()
    }
  })

  return app
}

export async function startServer(config: ServerConfig): Promise<void> {
  const app = createServer(config)
  const host = config.host ?? '0.0.0.0'
  const port = config.port ?? 3000
  await app.listen({ host, port })
}
