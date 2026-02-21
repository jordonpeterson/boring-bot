import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { replayRun } from '../src/replay.js'
import type { SDKMessage, StreamEvent } from '../src/types.js'

// Test stubs: SDKMessage is a large union with many required fields.
// We cast minimal objects so tests stay focused on replay behaviour, not SDK types.
const assistantMsg = { type: 'assistant' } as unknown as SDKMessage
const resultMsg    = { type: 'result'    } as unknown as SDKMessage

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'replay-test-'))
}

function writeLog(dir: string, events: StreamEvent[]): string {
  const logPath = join(dir, 'run.ndjson')
  writeFileSync(logPath, events.map((e) => JSON.stringify(e)).join('\n') + '\n')
  return logPath
}

async function drainAll(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const result: StreamEvent[] = []
  for await (const ev of gen) result.push(ev)
  return result
}

test('replays all events from a log file', async () => {
  const dir = makeTmpDir()
  try {
    const events: StreamEvent[] = [
      { type: 'event', runId: 'r1', seq: 0, ts: 1000, event: assistantMsg },
      { type: 'event', runId: 'r1', seq: 1, ts: 2000, event: resultMsg },
      { type: 'done',  runId: 'r1', exitCode: 0, logPath: '/tmp/r1.ndjson' },
    ]
    const logPath = writeLog(dir, events)
    const replayed = await drainAll(replayRun(logPath))
    assert.deepEqual(replayed, events)
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test('skips blank lines in the log file', async () => {
  const dir = makeTmpDir()
  try {
    const logPath = join(dir, 'run.ndjson')
    const event: StreamEvent = { type: 'done', runId: 'r1', exitCode: 0, logPath: '' }
    writeFileSync(logPath, '\n' + JSON.stringify(event) + '\n\n')
    const replayed = await drainAll(replayRun(logPath))
    assert.equal(replayed.length, 1)
    assert.deepEqual(replayed[0], event)
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test('throws immediately when the log file does not exist', async () => {
  await assert.rejects(
    async () => {
      for await (const _ of replayRun('/tmp/does-not-exist-boring-bot.ndjson')) {
        // should not reach here
      }
    },
    (err: unknown) => {
      assert.ok(err instanceof Error)
      assert.match((err as NodeJS.ErrnoException).code ?? '', /ENOENT/)
      return true
    },
  )
})

test('replays events in correct order', async () => {
  const dir = makeTmpDir()
  try {
    const events: StreamEvent[] = Array.from({ length: 10 }, (_, i) => ({
      type: 'event' as const,
      runId: 'r1',
      seq: i,
      ts: i * 100,
      event: assistantMsg,
    }))
    const logPath = writeLog(dir, events)
    const replayed = await drainAll(replayRun(logPath))
    assert.equal(replayed.length, 10)
    for (let i = 0; i < 10; i++) {
      assert.equal((replayed[i] as { seq: number }).seq, i)
    }
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test('realtime mode respects ts deltas (capped at 50 ms for test speed)', async () => {
  const dir = makeTmpDir()
  try {
    // Use small deltas so the test runs fast
    const events: StreamEvent[] = [
      { type: 'event', runId: 'r1', seq: 0, ts: 0,  event: assistantMsg },
      { type: 'event', runId: 'r1', seq: 1, ts: 20, event: assistantMsg },
      { type: 'event', runId: 'r1', seq: 2, ts: 40, event: resultMsg },
    ]
    const logPath = writeLog(dir, events)
    const start = Date.now()
    const replayed = await drainAll(replayRun(logPath, { realtime: true }))
    const elapsed = Date.now() - start
    assert.equal(replayed.length, 3)
    // Should have waited at least ~40 ms total (two 20 ms gaps), with some tolerance
    assert.ok(elapsed >= 30, `Expected elapsed >= 30ms, got ${elapsed}ms`)
  } finally {
    rmSync(dir, { recursive: true })
  }
})
