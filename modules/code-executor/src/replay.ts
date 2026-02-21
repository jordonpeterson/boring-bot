import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import type { StreamEvent } from './types.js'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function* replayRun(
  logPath: string,
  options?: { realtime?: boolean }
): AsyncGenerator<StreamEvent> {
  // Open the stream eagerly so a missing file throws immediately rather than
  // silently yielding nothing.
  const fileStream = createReadStream(logPath)
  await new Promise<void>((resolve, reject) => {
    fileStream.once('error', reject)
    fileStream.once('open', resolve)
  })

  const rl = createInterface({ input: fileStream, crlfDelay: Infinity })

  let prevTs: number | undefined

  try {
    for await (const line of rl) {
      if (line.trim() === '') continue

      const event = JSON.parse(line) as StreamEvent

      if (options?.realtime && event.type === 'event') {
        if (prevTs !== undefined) {
          const delta = event.ts - prevTs
          if (delta > 0) await sleep(delta)
        }
        prevTs = event.ts
      }

      yield event
    }
  } finally {
    rl.close()
    fileStream.destroy()
  }
}
