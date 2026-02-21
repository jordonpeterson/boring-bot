import { mkdirSync, chmodSync, createWriteStream, type WriteStream } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import Docker from 'dockerode'
import { LineTransform } from './line-transform.js'
import type {
  ExecuteOptions,
  ExecutorServiceConfig,
  RunEnvelope,
  RunnerConfig,
  StreamEvent,
} from './types.js'

const DEFAULT_IMAGE = 'boring-bot-runner:latest'
const DEFAULT_LOG_DIR = '/tmp/boring-bot-logs'
const DEFAULT_MEMORY = 1024 * 1024 * 1024 // 1 GiB
const DEFAULT_NANO_CPUS = 2e9                   // 2 vCPU

function closeStream(stream: WriteStream): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.end((err?: Error | null) => {
      if (err) reject(err)
      else resolve()
    })
  })
}

export class ExecutorService {
  private readonly image: string
  private readonly logDir: string
  private readonly memoryBytes: number
  private readonly nanoCpus: number
  private readonly getCredentials: () => Promise<import('./types.js').Credentials>
  private readonly docker: Docker

  constructor(config: ExecutorServiceConfig) {
    this.image = config.image ?? DEFAULT_IMAGE
    this.logDir = config.logDir ?? DEFAULT_LOG_DIR
    this.memoryBytes = config.memoryBytes ?? DEFAULT_MEMORY
    this.nanoCpus = config.nanoCpus ?? DEFAULT_NANO_CPUS
    this.getCredentials = config.getCredentials

    mkdirSync(this.logDir, { recursive: true })
    this.docker = new Docker()
  }

  async *execute(options: ExecuteOptions): AsyncGenerator<StreamEvent> {
    const runId = randomUUID()
    const logPath = join(this.logDir, `${runId}.ndjson`)
    const credentials = await this.getCredentials()

    // Resolve the agent workspace directory. If the caller didn't provide one,
    // auto-create a per-run directory so each run gets a clean slate.
    const agentDir = options.agentDir ?? join(this.logDir, runId)
    mkdirSync(agentDir, { recursive: true })
    // 0o777 lets the container's node user (uid 1000) write even though it
    // doesn't match the host uid. Acceptable for a local dev workspace.
    chmodSync(agentDir, 0o777)

    const runnerConfig: RunnerConfig = {
      prompt: options.prompt,
      options: {
        resume: options.resume,
        allowedTools: options.allowedTools,
        maxTurns: options.maxTurns,
        permissionMode: options.permissionMode,
      },
    }

    // agentDir is always mounted as the writable workspace root.
    // contextPath (if given) is nested inside it as read-only reference material.
    const binds: string[] = [`${agentDir}:/workspace:rw`]
    if (options.contextPath) {
      binds.push(`${options.contextPath}:/workspace/context:ro`)
    }

    const container = await this.docker.createContainer({
      Image: this.image,
      Env: [
        `CLAUDE_RUN_CONFIG=${JSON.stringify(runnerConfig)}`,
        credentials.type === 'api_key'
          ? `ANTHROPIC_API_KEY=${credentials.value}`
          : `CLAUDE_CODE_OAUTH_TOKEN=${credentials.value}`,
      ],
      HostConfig: {
        Binds: binds,
        Memory: this.memoryBytes,
        NanoCpus: this.nanoCpus,
        NetworkMode: 'bridge',
        AutoRemove: true,
      },
    })

    // try-finally ensures logStream is always closed, even if the caller abandons
    // the generator early or an error occurs during container setup.
    const logStream = createWriteStream(logPath)
    try {
      // Async push queue — events are written to both the log file and the queue.
      const queue: StreamEvent[] = []
      let done = false
      // Capture and clear the resolver atomically in push() to prevent a second
      // call from the "done" signal after push() already woke the yield loop.
      let resolveWaiter: (() => void) | undefined

      function push(ev: StreamEvent): void {
        queue.push(ev)
        logStream.write(JSON.stringify(ev) + '\n')
        const r = resolveWaiter
        resolveWaiter = undefined
        r?.()
      }

      const stdoutTransform = new LineTransform((line) => {
        try {
          const envelope = JSON.parse(line) as RunEnvelope
          push({ type: 'event', runId, seq: envelope.seq, ts: envelope.ts, event: envelope.event })
        } catch {
          push({ type: 'error', runId, text: `[stdout] ${line}` })
        }
      })

      const stderrTransform = new LineTransform((line) => {
        push({ type: 'error', runId, text: `[stderr] ${line}` })
      })

      const attachStream = await container.attach({ stream: true, stdout: true, stderr: true })
      container.modem.demuxStream(attachStream, stdoutTransform, stderrTransform)

      const waitForEnd = new Promise<void>((resolve) => {
        attachStream.on('end', resolve)
        attachStream.on('close', resolve)
      })

      await container.start()

      // Call container.wait() exactly once. The exit code is captured here so
      // we never need to await this promise a second time.
      let exitCode = 0
      void Promise.all([waitForEnd, container.wait()]).then(([, { StatusCode }]) => {
        exitCode = StatusCode
        // Flush any remaining buffered lines from both transforms.
        stdoutTransform.end()
        stderrTransform.end()
        done = true
        // Wake the yield loop if it is currently waiting.
        const r = resolveWaiter
        resolveWaiter = undefined
        r?.()
      })

      // Yield loop — race-safe against the window between "check done" and
      // "set resolveWaiter". After assigning the resolver we re-check the
      // condition so that any push() or done signal that arrived in the
      // microtask gap resolves the promise immediately rather than hanging.
      while (true) {
        while (queue.length > 0) {
          yield queue.shift()!
        }
        if (done) break
        await new Promise<void>((resolve) => {
          resolveWaiter = resolve
          // Re-check after assigning: a push() or done signal may have raced in
          // between the outer "if (done) break" check and this assignment.
          if (queue.length > 0 || done) {
            resolveWaiter = undefined
            resolve()
          }
        })
      }

      // Drain any items that were pushed during the final transform flush.
      while (queue.length > 0) {
        yield queue.shift()!
      }

      yield { type: 'done', runId, exitCode, logPath, agentDir }
    } finally {
      await closeStream(logStream)
    }
  }
}
