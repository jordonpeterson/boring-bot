import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { LineTransform } from '../src/line-transform.js'

function collect(input: string[]): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const lines: string[] = []
    const transform = new LineTransform((line) => lines.push(line))
    transform.on('finish', () => resolve(lines))
    transform.on('error', reject)
    for (const chunk of input) transform.write(chunk)
    transform.end()
  })
}

test('emits complete lines from a single chunk', async () => {
  const lines = await collect(['hello\nworld\n'])
  assert.deepEqual(lines, ['hello', 'world'])
})

test('handles split chunks that straddle a newline', async () => {
  const lines = await collect(['hel', 'lo\nwor', 'ld\n'])
  assert.deepEqual(lines, ['hello', 'world'])
})

test('flushes a trailing line with no final newline', async () => {
  const lines = await collect(['hello\nworld'])
  assert.deepEqual(lines, ['hello', 'world'])
})

test('skips blank lines', async () => {
  const lines = await collect(['a\n\nb\n\n\nc\n'])
  assert.deepEqual(lines, ['a', 'b', 'c'])
})

test('skips whitespace-only lines', async () => {
  const lines = await collect(['a\n   \nb\n'])
  assert.deepEqual(lines, ['a', 'b'])
})

test('handles many lines in one chunk', async () => {
  const input = Array.from({ length: 100 }, (_, i) => `line${i}`).join('\n') + '\n'
  const lines = await collect([input])
  assert.equal(lines.length, 100)
  assert.equal(lines[0], 'line0')
  assert.equal(lines[99], 'line99')
})

test('handles empty input', async () => {
  const lines = await collect([''])
  assert.deepEqual(lines, [])
})

test('pipes correctly from a Readable', async () => {
  const lines: string[] = []
  await new Promise<void>((resolve, reject) => {
    const src = Readable.from(['foo\nbar\n'])
    const transform = new LineTransform((line) => lines.push(line))
    transform.on('finish', resolve)
    transform.on('error', reject)
    src.pipe(transform)
  })
  assert.deepEqual(lines, ['foo', 'bar'])
})
