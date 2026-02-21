import { Transform, type TransformCallback } from 'node:stream'

export class LineTransform extends Transform {
  private buffer = ''
  private readonly onLine: (line: string) => void

  constructor(onLine: (line: string) => void) {
    super({ readableObjectMode: true })
    this.onLine = onLine
  }

  override _transform(chunk: Buffer | string, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.buffer += chunk.toString()
    const lines = this.buffer.split('\n')
    // Keep the last (potentially incomplete) segment in the buffer
    this.buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (line.trim() !== '') {
        this.onLine(line)
      }
    }
    callback()
  }

  override _flush(callback: TransformCallback): void {
    if (this.buffer.trim() !== '') {
      this.onLine(this.buffer)
    }
    this.buffer = ''
    callback()
  }
}
