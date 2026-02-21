import type { SDKMessage, StreamEvent } from '@boring-bot/code-executor'
import type { AgentEvent, SessionSummaryData, RunningCost } from './types.js'
import { CostCalculator } from './cost-calculator.js'
import { EventIngester } from './ingester.js'
import { ToolAggregator } from './tool-aggregator.js'
import { buildSessionSummary } from './session-summary.js'
import type { PricingEntry } from './types.js'

/** Options for createAnalyzer. */
export interface AnalyzerOptions {
  /** Custom pricing table override. */
  pricing?: Record<string, PricingEntry>
}

/** Result object returned by the analyzer after processing each event. */
export interface AnalyzeResult {
  /** The normalised event (null when the raw message was skipped). */
  event: AgentEvent | null
  /** Running cost snapshot after this event. */
  runningCost: RunningCost
  /** True when this event was the final result message. */
  isResult: boolean
}

/**
 * Convenience wrapper that wires up all components.
 *
 * Accepts an AsyncIterable of SDKMessage or StreamEvent and yields
 * an AnalyzeResult for each.  After the iterator completes, call
 * `getSessionSummary()` for the full session report.
 */
export class Analyzer {
  private readonly calculator: CostCalculator
  private readonly ingester: EventIngester
  private readonly aggregator: ToolAggregator
  private readonly events: AgentEvent[] = []
  private resultMessage: Record<string, unknown> | null = null

  constructor(options?: AnalyzerOptions) {
    this.calculator = new CostCalculator(options?.pricing)
    this.ingester = new EventIngester(this.calculator)
    this.aggregator = new ToolAggregator()
  }

  /**
   * Process a single SDKMessage.  Returns an AnalyzeResult.
   */
  processMessage(message: SDKMessage): AnalyzeResult {
    const event = this.ingester.ingest(message)

    if (event) {
      this.events.push(event)

      // Update running cost.
      if (event.usage) {
        this.calculator.updateRunningTotal(event.usage, event.model)
      }

      // Track tool calls.
      if (event.toolCalls.length > 0) {
        this.aggregator.record(event.toolCalls)
      }

      // Capture result message for session summary.
      if (event.type === 'result') {
        this.resultMessage = message as unknown as Record<string, unknown>
      }
    }

    return {
      event,
      runningCost: this.calculator.getRunningCost(),
      isResult: event?.type === 'result',
    }
  }

  /**
   * Process a StreamEvent from the code executor.
   * Extracts the SDKMessage from 'event'-type StreamEvents and processes it.
   * Returns null for 'error' and 'done' StreamEvents.
   */
  processStreamEvent(streamEvent: StreamEvent): AnalyzeResult | null {
    if (streamEvent.type !== 'event') return null
    return this.processMessage(streamEvent.event)
  }

  /** Get the list of all normalised events processed so far. */
  getEvents(): AgentEvent[] {
    return [...this.events]
  }

  /** Get the current running cost snapshot. */
  getRunningCost(): RunningCost {
    return this.calculator.getRunningCost()
  }

  /** Get the tool call aggregator. */
  getToolAggregator(): ToolAggregator {
    return this.aggregator
  }

  /**
   * Build the full session summary.
   * Best called after the result message has been processed.
   */
  getSessionSummary(): SessionSummaryData {
    return buildSessionSummary(
      this.events,
      this.resultMessage,
      this.calculator,
      this.aggregator,
    )
  }

  /** Reset all state for processing a new session. */
  reset(): void {
    this.calculator.reset()
    this.ingester.reset()
    this.aggregator.reset()
    this.events.length = 0
    this.resultMessage = null
  }
}

/**
 * Create an Analyzer instance.
 *
 * Convenience factory for the common case.
 */
export function createAnalyzer(options?: AnalyzerOptions): Analyzer {
  return new Analyzer(options)
}
