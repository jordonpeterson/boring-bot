import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { ToolAggregator } from '../src/tool-aggregator.js'
import type { ToolCall } from '../src/types.js'

function makeCall(name: string, id: string): ToolCall {
  return { toolName: name, toolId: id, input: {} }
}

describe('ToolAggregator', () => {
  test('records a single tool call', () => {
    const agg = new ToolAggregator()
    agg.record([makeCall('Read', 'toolu_01')])

    const summary = agg.get('Read')
    assert.ok(summary)
    assert.equal(summary.count, 1)
    assert.deepEqual(summary.toolIds, ['toolu_01'])
  })

  test('counts multiple calls to the same tool', () => {
    const agg = new ToolAggregator()
    agg.record([makeCall('Read', 'toolu_01')])
    agg.record([makeCall('Read', 'toolu_02')])
    agg.record([makeCall('Read', 'toolu_03')])

    const summary = agg.get('Read')
    assert.ok(summary)
    assert.equal(summary.count, 3)
    assert.deepEqual(summary.toolIds, ['toolu_01', 'toolu_02', 'toolu_03'])
  })

  test('tracks multiple different tools', () => {
    const agg = new ToolAggregator()
    agg.record([makeCall('Read', 'toolu_01')])
    agg.record([makeCall('Write', 'toolu_02')])
    agg.record([makeCall('Bash', 'toolu_03')])

    assert.equal(agg.get('Read')?.count, 1)
    assert.equal(agg.get('Write')?.count, 1)
    assert.equal(agg.get('Bash')?.count, 1)
  })

  test('handles multiple tool calls in a single message', () => {
    const agg = new ToolAggregator()
    agg.record([
      makeCall('Read', 'toolu_01'),
      makeCall('Bash', 'toolu_02'),
      makeCall('Read', 'toolu_03'),
    ])

    assert.equal(agg.get('Read')?.count, 2)
    assert.equal(agg.get('Bash')?.count, 1)
  })

  test('returns undefined for unknown tool', () => {
    const agg = new ToolAggregator()
    assert.equal(agg.get('NonExistent'), undefined)
  })

  test('getSummary returns all tools', () => {
    const agg = new ToolAggregator()
    agg.record([makeCall('Read', 'toolu_01')])
    agg.record([makeCall('Write', 'toolu_02')])

    const summary = agg.getSummary()
    assert.ok(summary['Read'])
    assert.ok(summary['Write'])
    assert.equal(Object.keys(summary).length, 2)
  })

  test('getSummary returns copies not references', () => {
    const agg = new ToolAggregator()
    agg.record([makeCall('Read', 'toolu_01')])

    const s1 = agg.getSummary()
    agg.record([makeCall('Read', 'toolu_02')])
    const s2 = agg.getSummary()

    assert.equal(s1['Read'].count, 1)
    assert.equal(s2['Read'].count, 2)
  })

  test('get returns a copy not a reference', () => {
    const agg = new ToolAggregator()
    agg.record([makeCall('Read', 'toolu_01')])

    const copy = agg.get('Read')!
    copy.count = 999
    copy.toolIds.push('fake')

    assert.equal(agg.get('Read')!.count, 1)
    assert.equal(agg.get('Read')!.toolIds.length, 1)
  })

  test('getTotalCount sums across all tools', () => {
    const agg = new ToolAggregator()
    agg.record([makeCall('Read', 'toolu_01')])
    agg.record([makeCall('Write', 'toolu_02')])
    agg.record([makeCall('Read', 'toolu_03')])
    agg.record([makeCall('Bash', 'toolu_04'), makeCall('Grep', 'toolu_05')])

    assert.equal(agg.getTotalCount(), 5)
  })

  test('getToolNames returns unique names', () => {
    const agg = new ToolAggregator()
    agg.record([makeCall('Read', 'toolu_01')])
    agg.record([makeCall('Write', 'toolu_02')])
    agg.record([makeCall('Read', 'toolu_03')])

    const names = agg.getToolNames()
    assert.deepEqual(names.sort(), ['Read', 'Write'])
  })

  test('reset clears all state', () => {
    const agg = new ToolAggregator()
    agg.record([makeCall('Read', 'toolu_01')])
    agg.record([makeCall('Write', 'toolu_02')])

    agg.reset()

    assert.equal(agg.getTotalCount(), 0)
    assert.equal(agg.getToolNames().length, 0)
    assert.equal(agg.get('Read'), undefined)
  })

  test('handles empty tool call array', () => {
    const agg = new ToolAggregator()
    agg.record([])
    assert.equal(agg.getTotalCount(), 0)
  })
})
