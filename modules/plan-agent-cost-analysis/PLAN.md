# Plan: Agent Cost Analysis

Analyze AI agent logs (starting with the Claude Agent SDK) to track costs, aggregate tool calls, and surface usage insights. Events are processed one at a time from the SDK's async message stream.

---

## 1. Data Model — What We Track

### Per-Event Record (`AgentEvent`)

Each event emitted by the SDK (`SDKMessage`) is consumed and normalized into an internal record:

| Field | Source | Description |
|:------|:-------|:------------|
| `eventId` | generated | Unique ID for this record |
| `sessionId` | `message.session_id` | Groups events to a single agent run |
| `timestamp` | wall-clock at ingestion | When we observed the event |
| `type` | `message.type` | `system`, `assistant`, `user`, `result`, `stream_event` |
| `subtype` | `message.subtype` | e.g. `init`, `success`, `error_max_turns` |
| `model` | from `system.init` or `resultMessage.modelUsage` keys | Which model produced this |
| `messageId` | `message.message.id` (assistant only) | Deduplication key — multiple content blocks share one ID |
| `parentToolUseId` | `message.parent_tool_use_id` | Links sub-agent responses to the tool call that spawned them |
| `usage` | `message.message.usage` | `{ input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens }` |
| `contentBlocks` | `message.message.content` | Array of text / tool_use / tool_result blocks |
| `toolCalls` | extracted from content blocks of type `tool_use` | `{ toolName, toolId, input }` |
| `costUsd` | computed from usage + pricing table | Per-message cost |

### Session Summary (`SessionSummary`)

Materialized after the `result` message arrives (or on-demand from accumulated events):

| Field | Description |
|:------|:------------|
| `sessionId` | The agent run identifier |
| `model` | Primary model used |
| `status` | `success`, `error_max_turns`, `error_during_execution`, `error_max_budget_usd` |
| `durationMs` | Total wall-clock time |
| `durationApiMs` | Time spent waiting on Claude API |
| `numTurns` | Total conversation turns |
| `totalCostUsd` | Authoritative cost from `ResultMessage.total_cost_usd` |
| `computedCostUsd` | Our independently calculated cost (sanity check) |
| `tokenUsage` | Aggregate `{ input, output, cacheCreation, cacheRead }` |
| `modelUsage` | Per-model breakdown map from `ResultMessage.modelUsage` |
| `toolCallSummary` | `Map<toolName, { count, totalDurationMs }>` |
| `permissionDenials` | Count and details of permission denials |
| `compactions` | Number of context compactions and pre-compaction token counts |

---

## 2. Architecture

```
                  Claude Agent SDK
                        │
                   async iterator
                        │
                        ▼
              ┌───────────────────┐
              │   EventIngester   │  — consumes one SDKMessage at a time
              │                   │  — normalizes into AgentEvent
              │                   │  — deduplicates by messageId
              └────────┬──────────┘
                       │
                       ▼
              ┌───────────────────┐
              │   EventStore      │  — append-only log of AgentEvents
              │   (in-memory)     │  — indexed by sessionId
              └────────┬──────────┘
                       │
            ┌──────────┴──────────┐
            ▼                     ▼
  ┌──────────────────┐  ┌──────────────────┐
  │  CostCalculator  │  │  ToolAggregator  │
  │                  │  │                  │
  │ - pricing table  │  │ - counts by name │
  │ - per-msg cost   │  │ - call durations │
  │ - running total  │  │ - success/fail   │
  └──────────────────┘  └──────────────────┘
            │                     │
            └──────────┬──────────┘
                       ▼
              ┌───────────────────┐
              │ SessionSummary    │  — built on result event or on-demand
              │ (materializer)    │
              └───────────────────┘
```

### Key Components

#### `EventIngester`
- Accepts a single `SDKMessage` via `ingest(message: SDKMessage): AgentEvent | null`
- Returns `null` for messages that don't produce a new record (duplicate messageId, stream events when not tracking streaming)
- Tracks seen message IDs to avoid double-counting usage
- Extracts tool_use blocks from assistant message content

#### `CostCalculator`
- Holds a `PricingTable`: `Map<modelId, { inputPerMTok, outputPerMTok, cacheWritePerMTok, cacheReadPerMTok }>`
- `calculateCost(usage, model): number` — returns USD cost for a single message
- `updateRunningTotal(agentEvent): RunningCost` — accumulates session-wide cost
- Pricing table is a plain data structure, easy to update when Anthropic changes prices

#### `ToolAggregator`
- `recordToolCall(toolName, toolId): void`
- `recordToolResult(toolId, durationMs, success): void`
- `getSummary(): Map<toolName, { count, avgDurationMs, successRate }>`

#### `SessionSummary` (materializer)
- `fromEvents(events: AgentEvent[]): SessionSummary`
- `fromResultMessage(resultMsg: SDKResultMessage, events: AgentEvent[]): SessionSummary`
- Cross-checks `computedCostUsd` against `total_cost_usd` from the SDK

---

## 3. Pricing Table

Stored as a static data structure, versioned by date. Initial table:

```typescript
type PricingEntry = {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheWrite5mPerMTok: number;
  cacheWrite1hPerMTok: number;
  cacheReadPerMTok: number;
};

const PRICING: Record<string, PricingEntry> = {
  "claude-opus-4-6":   { inputPerMTok: 5.00,  outputPerMTok: 25.00, cacheWrite5mPerMTok: 6.25,  cacheWrite1hPerMTok: 10.00, cacheReadPerMTok: 0.50 },
  "claude-opus-4-5":   { inputPerMTok: 5.00,  outputPerMTok: 25.00, cacheWrite5mPerMTok: 6.25,  cacheWrite1hPerMTok: 10.00, cacheReadPerMTok: 0.50 },
  "claude-opus-4-1":   { inputPerMTok: 15.00, outputPerMTok: 75.00, cacheWrite5mPerMTok: 18.75, cacheWrite1hPerMTok: 30.00, cacheReadPerMTok: 1.50 },
  "claude-opus-4":     { inputPerMTok: 15.00, outputPerMTok: 75.00, cacheWrite5mPerMTok: 18.75, cacheWrite1hPerMTok: 30.00, cacheReadPerMTok: 1.50 },
  "claude-sonnet-4-6": { inputPerMTok: 3.00,  outputPerMTok: 15.00, cacheWrite5mPerMTok: 3.75,  cacheWrite1hPerMTok: 6.00,  cacheReadPerMTok: 0.30 },
  "claude-sonnet-4-5": { inputPerMTok: 3.00,  outputPerMTok: 15.00, cacheWrite5mPerMTok: 3.75,  cacheWrite1hPerMTok: 6.00,  cacheReadPerMTok: 0.30 },
  "claude-sonnet-4":   { inputPerMTok: 3.00,  outputPerMTok: 15.00, cacheWrite5mPerMTok: 3.75,  cacheWrite1hPerMTok: 6.00,  cacheReadPerMTok: 0.30 },
  "claude-haiku-4-5":  { inputPerMTok: 1.00,  outputPerMTok: 5.00,  cacheWrite5mPerMTok: 1.25,  cacheWrite1hPerMTok: 2.00,  cacheReadPerMTok: 0.10 },
  "claude-haiku-3-5":  { inputPerMTok: 0.80,  outputPerMTok: 4.00,  cacheWrite5mPerMTok: 1.00,  cacheWrite1hPerMTok: 1.60,  cacheReadPerMTok: 0.08 },
  "claude-haiku-3":    { inputPerMTok: 0.25,  outputPerMTok: 1.25,  cacheWrite5mPerMTok: 0.30,  cacheWrite1hPerMTok: 0.50,  cacheReadPerMTok: 0.03 },
};
```

---

## 4. Event Processing Flow (one event at a time)

```
for await (const message of claude.query({ ... })) {
  const event = ingester.ingest(message);
  if (!event) continue;

  // Real-time cost tracking
  if (event.usage) {
    costCalculator.updateRunningTotal(event);
  }

  // Tool call tracking
  for (const toolCall of event.toolCalls) {
    toolAggregator.recordToolCall(toolCall.toolName, toolCall.toolId);
  }

  // Session finalization
  if (event.type === "result") {
    const summary = SessionSummary.fromResultMessage(message, eventStore.getEvents(event.sessionId));
    // summary is now available for reporting / storage
  }
}
```

---

## 5. Module Public API (planned exports)

```typescript
// Core ingestion
export { EventIngester } from "./ingester";
export type { AgentEvent } from "./types";

// Cost calculation
export { CostCalculator, PRICING } from "./cost-calculator";
export type { PricingEntry, RunningCost } from "./types";

// Tool aggregation
export { ToolAggregator } from "./tool-aggregator";
export type { ToolCallSummary } from "./types";

// Session summary
export { SessionSummary } from "./session-summary";
export type { SessionSummaryData } from "./types";

// Convenience: wrap an SDK query iterator and return enriched events
export { createAnalyzer } from "./analyzer";
```

---

## 6. File Layout

```
modules/plan-agent-cost-analysis/
├── package.json
├── tsconfig.json
├── PLAN.md              ← this file
└── src/
    ├── index.ts          ← public API re-exports
    ├── types.ts          ← AgentEvent, SessionSummaryData, PricingEntry, etc.
    ├── pricing.ts        ← PRICING table constant
    ├── ingester.ts       ← EventIngester class
    ├── cost-calculator.ts ← CostCalculator class
    ├── tool-aggregator.ts ← ToolAggregator class
    ├── session-summary.ts ← SessionSummary materializer
    └── analyzer.ts       ← createAnalyzer() convenience wrapper
```

---

## 7. Key Design Decisions

| Decision | Rationale |
|:---------|:----------|
| **One event at a time** | Matches the SDK's async iterator model; no buffering needed |
| **Deduplicate by `message.id`** | SDK emits the same usage on multiple content blocks sharing one ID |
| **Pricing table as static data** | Simple, versionable, no API call needed; update when prices change |
| **Cross-check computed vs. authoritative cost** | `ResultMessage.total_cost_usd` is ground truth; our calculation is a sanity check and provides per-event granularity the SDK doesn't give |
| **In-memory EventStore** | Good enough for single-run analysis; persistence layer can be added later |
| **No streaming event tracking initially** | Partial messages add complexity; assistant messages already contain the complete data |
| **Tool aggregation separate from cost** | Different concerns; tool counts are useful even without cost data |

---

## 8. Future Extensions (not in initial scope)

- **Persistent storage** — write events/summaries to SQLite or a file for cross-session analysis
- **Multi-provider support** — OpenAI, Google, etc. with provider-specific pricing tables
- **Budget alerts** — callback when running cost exceeds a threshold
- **Streaming progress** — track partial message token counts in real-time
- **Sub-agent tracking** — use `parentToolUseId` to build a tree of agent/sub-agent costs
- **Export formats** — JSON, CSV, or integration with observability tools
