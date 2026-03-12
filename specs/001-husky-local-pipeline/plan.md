# Implementation Plan: Local Push Pipeline with Husky

**Branch**: `001-husky-local-pipeline` | **Date**: 2026-03-10 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `/specs/001-husky-local-pipeline/spec.md`

## Summary

Build `@boring-bot/pipeline`, a TypeScript module that serves as a locally-enforced CI pipeline orchestrator triggered by Husky's `pre-push` git hook. On every `git push`, the hook computes the diff of pushed commits, passes it to each configured stage (tests, AI review agents, linters) in order, blocks the push on any failure, and appends the full run result to a local NDJSON log file. Stages are declared in a `pipeline.config.json` at the repo root; new stages are added by editing the JSON file only — no core pipeline code changes required.

## Technical Context

**Language/Version**: TypeScript 5.x, strict mode, ESM (`"type": "module"`)
**Primary Dependencies**: Node.js LTS built-ins only (`child_process`, `fs/promises`, `readline`); Husky v9 (devDependency at repo root)
**Storage**: `pipeline.config.json` (JSON, version-controlled); `.pipeline-runs.log` (NDJSON, gitignored)
**Testing**: vitest (consistent with other modules in the monorepo)
**Target Platform**: macOS developer machine (local only; no server, no CI service)
**Project Type**: CLI tool invoked as a git hook
**Performance Goals**: ≤5 seconds pipeline overhead beyond cumulative stage execution time (SC-002)
**Constraints**: Fully offline; no network calls from the pipeline orchestrator itself; stages may make network calls (AI agents)
**Scale/Scope**: Single-developer local tool; one pipeline run per push; stages run sequentially

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| III — Module-First | ✅ Pass | New module `@boring-bot/pipeline` under `modules/`; self-contained with own `package.json` and `tsconfig.json` |
| IV — TypeScript Strict | ✅ Pass | All source code is TypeScript. The `.husky/pre-push` shell shim is unavoidable infrastructure (git hooks must be POSIX shell); it contains zero business logic — all logic lives in the TypeScript module. See Complexity Tracking. |
| V — Test-First | ✅ Pass | Tests written before implementation; tracked in tasks.md |
| VI — Security by Design | ✅ N/A | No untrusted code execution; no container required. Stage scripts are version-controlled in the repo (trusted source). Pipeline runs with developer's own permissions — appropriate for a developer tooling use case. |
| VII — YAGNI | ✅ Pass | Stage config schema is minimal (`name`, `command`, `timeout` only). Optional fields (`enabled`, `env`, `workingDirectory`) deferred — no current requirement. |

## Project Structure

### Documentation (this feature)

```text
specs/001-husky-local-pipeline/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/
│   └── stage-contract.md   # Phase 1 output
└── tasks.md             # Phase 2 output (/speckit.tasks command)
```

### Source Code (repository root)

```text
modules/pipeline/
├── package.json          # @boring-bot/pipeline, private, ESM
├── tsconfig.json         # extends ../../tsconfig.base.json
├── src/
│   ├── index.ts          # Entry point: reads git hook stdin, loads config, runs pipeline
│   ├── runner.ts         # Pipeline orchestrator: iterates stages, collects results, writes log
│   ├── stage.ts          # Stage execution: child_process with AbortController timeout + process tree kill
│   ├── config.ts         # Pipeline config loader: reads pipeline.config.json, validates schema
│   ├── logger.ts         # Run log writer: appends PipelineResult as NDJSON to .pipeline-runs.log
│   └── reporter.ts       # Terminal output formatter: section headers, symbols, duration
└── test/
    ├── config.test.ts    # Config loading and validation
    ├── stage.test.ts     # Stage execution, timeout, exit code handling
    ├── runner.test.ts    # Pipeline orchestration, fail-fast, result aggregation
    └── logger.test.ts    # NDJSON log append, entry format

.husky/
└── pre-push              # POSIX shell shim: parses git stdin, computes diff range, pipes to node

pipeline.config.json      # Stage declarations (repo root, version-controlled)
.pipeline-runs.log        # Append-only NDJSON run history (repo root, gitignored)
```

**Structure Decision**: Single module under `modules/pipeline/`. No additional projects required. The Husky hook and config file live at the repo root (not inside the module) because they are repository-level concerns, not module internals.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|--------------------------------------|
| Shell shim in `.husky/pre-push` (not TypeScript) | Git hooks must be POSIX shell scripts; git executes them directly without a Node.js runtime | Could not make the hook a `.ts` file — git does not know how to execute TypeScript. The shim is <20 lines with zero business logic; all logic is in the TypeScript module. |

## Key Design Decisions

### Stage Input: Full Diff via Stdin
All stages receive the full `git diff` of pushed commits via stdin. This is the simplest contract that works for both conventional scripts and AI review agents (which need the full diff text). Stages may ignore stdin if they prefer to query git directly using the `PIPELINE_COMMIT_SHA` environment variable.

### Fail-Fast with Sequential Execution
Stages run sequentially. On the first failure, remaining stages are skipped and marked `skipped`. This keeps the feedback loop short and avoids wasting time (and API credits for AI stages) when the pipeline is already going to fail.

### NDJSON Log
Each pipeline run appends one JSON line to `.pipeline-runs.log`. The file is append-only and gitignored. No lock file is needed because sequential execution means at most one write per push. Stage output in the log is capped at 50,000 characters per stage to prevent unbounded growth.

### No Bypass Mechanism
The pipeline is always enforced. Git's native `--no-verify` flag still bypasses Husky hooks at the git level — this is outside the pipeline's scope and cannot be prevented.

## Phase 0 Artifacts

- [research.md](research.md) — all technical decisions resolved; no NEEDS CLARIFICATION items remain.

## Phase 1 Artifacts

- [data-model.md](data-model.md) — entity schemas for PipelineConfig, StageResult, PipelineResult, RunLog, DiffInput
- [contracts/stage-contract.md](contracts/stage-contract.md) — stage input/output/exit-code contract
- [quickstart.md](quickstart.md) — setup and daily use guide


