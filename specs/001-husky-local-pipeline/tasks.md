# Tasks: Local Push Pipeline with Husky

**Input**: Design documents from `/specs/001-husky-local-pipeline/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/stage-contract.md

**Tests**: Included per Constitution Principle V (Test-First is mandatory — tests must demonstrably fail before implementation).

**Organization**: Tasks grouped by user story to enable independent implementation and testing.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: User story this task belongs to (US1, US2, US3)
- Exact file paths included in all descriptions

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Initialize `@boring-bot/pipeline` module and repository-level tooling. No business logic here.

- [x] T001 Create `modules/pipeline/` directory structure with `src/` and `test/` subdirectories
- [x] T002 Create `modules/pipeline/package.json` with name `@boring-bot/pipeline`, `"private": true`, `"type": "module"`, vitest devDependency, and `build`/`test` scripts
- [x] T003 [P] Create `modules/pipeline/tsconfig.json` extending `../../tsconfig.base.json` with `rootDir: "src"` and `outDir: "dist"`
- [x] T004 [P] Define shared TypeScript types in `modules/pipeline/src/types.ts`: `PipelineConfig`, `StageConfig`, `StageStatus` (`"pass" | "fail" | "timeout" | "skipped"`), `StageResult`, `PipelineResult`, `DiffInput`
- [x] T005 Run `pnpm install` from repo root to register `@boring-bot/pipeline` as a workspace package
- [x] T006 [P] Add `.pipeline-runs.log` to `.gitignore` at repo root
- [x] T007 Install Husky at repo root: `pnpm add -D husky` then `pnpm exec husky init` (creates `.husky/` and adds `"prepare": "husky"` to root `package.json`)

**Checkpoint**: Module scaffolding complete — no TypeScript errors on `pnpm --filter @boring-bot/pipeline run build` (empty source is fine at this point)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Config loader and stage executor — the core engine that ALL user stories depend on.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [x] T008 Write failing unit tests for config loader in `modules/pipeline/test/config.test.ts`: valid config returns typed `PipelineConfig`; missing file throws descriptive error; invalid JSON throws; empty `stages` array throws; stage missing `name`/`command`/`timeout` throws
- [x] T009 Implement config loader in `modules/pipeline/src/config.ts`: reads `pipeline.config.json` from repo root (process.cwd()), JSON parses, validates required fields, throws `Error` with descriptive message on any violation; exports `loadConfig(): Promise<PipelineConfig>`
- [x] T010 Write failing unit tests for stage executor in `modules/pipeline/test/stage.test.ts`: exit 0 → status `"pass"`; exit non-zero → status `"fail"` with correct exitCode; timeout exceeded → status `"timeout"` + process killed; stdout+stderr captured in `output`; missing binary → `"fail"` with descriptive error message
- [x] T011 Implement stage executor in `modules/pipeline/src/stage.ts`: spawns command via `child_process.spawn` with `AbortController` timeout (SIGTERM → 5s grace → SIGKILL); uses `detached: true` and `process.kill(-pid)` for process tree kill on POSIX; captures combined stdout+stderr; exports `runStage(stage: StageConfig, diff: string): Promise<StageResult>`
- [x] T012 Create `pipeline.config.json` at repo root with a single Tests stage: `{ "stages": [{ "name": "Tests", "command": "pnpm -r run test --if-present", "timeout": 120000 }] }`

**Checkpoint**: `pnpm --filter @boring-bot/pipeline run test` passes all T008–T011 tests (red → green for config and stage executor)

---

## Phase 3: User Story 1 — Blocked Push on Failing Tests (Priority: P1) 🎯 MVP

**Goal**: Every `git push` automatically runs all test suites; any test failure blocks the push with clear output showing what failed.

**Independent Test**: Introduce a failing test in any module, run `git push`, verify the push is rejected and the failing test output is shown. Then fix the test, push again, verify it succeeds.

### Tests for User Story 1 ⚠️ Write FIRST — must FAIL before implementing

- [x] T013 Write failing unit tests for pipeline runner in `modules/pipeline/test/runner.test.ts`: all stages pass → `PipelineResult.status = "pass"`; first stage fails → `status = "fail"` + remaining stages are `"skipped"`; missing binary in config → `status = "fail"` with descriptive message in stage output

### Implementation for User Story 1

- [x] T014 [US1] Implement pipeline runner in `modules/pipeline/src/runner.ts`: iterates `PipelineConfig.stages` sequentially, calls `runStage` for each, stops on first non-`"pass"` result (fail-fast), marks remaining stages `"skipped"`, returns `PipelineResult`; exports `runPipeline(config: PipelineConfig, diff: DiffInput): Promise<PipelineResult>`
- [x] T015 [US1] Implement entry point in `modules/pipeline/src/index.ts`: reads `PIPELINE_COMMIT_SHA` and `PIPELINE_BRANCH` from `process.env`, reads diff from `process.stdin`, calls `loadConfig()` then `runPipeline()`, exits with code `0` on pass or `1` on fail; all unhandled errors exit `1` with message to stderr
- [x] T016 [US1] Create `.husky/pre-push` POSIX shell shim: reads git hook stdin (`local_ref local_sha remote_ref remote_sha`), skips deletions (local_sha = zero SHA), computes diff range (`$remote_sha..$local_sha` or merge-base for new branches), pipes `git diff "$diff_range"` to `node modules/pipeline/dist/index.js` with `PIPELINE_COMMIT_SHA` and `PIPELINE_BRANCH` env vars set; exits 1 if node exits non-zero; `chmod +x .husky/pre-push`
- [x] T017 [US1] Build `@boring-bot/pipeline` (`pnpm --filter @boring-bot/pipeline run build`) and verify end-to-end: push a commit with a deliberate test failure is blocked; push a commit with all tests passing succeeds

**Checkpoint**: US1 fully functional — the push pipeline blocks on test failure and allows on test pass. `git push` is the only invocation needed.

---

## Phase 4: User Story 2 — Automated Code Review on Push (Priority: P2)

**Goal**: Review stage scripts (conventional linters or AI agents) run against the pushed diff; any flagged issue unconditionally blocks the push.

**Independent Test**: Add a review stage to `pipeline.config.json` pointing to `scripts/review/example-review.sh`. Configure the script to exit 1 on a known pattern in the diff. Push a commit matching that pattern; verify the push is blocked with the review output shown. Remove the pattern; verify push succeeds.

### Tests for User Story 2 ⚠️ Write FIRST — must FAIL before implementing

- [x] T018 [P] [US2] Add tests to `modules/pipeline/test/stage.test.ts` verifying: `PIPELINE_COMMIT_SHA` and `PIPELINE_BRANCH` are present in the child process environment; diff text written to stdin is readable by the child process

### Implementation for User Story 2

- [x] T019 [US2] Update `modules/pipeline/src/stage.ts` to merge `PIPELINE_COMMIT_SHA` and `PIPELINE_BRANCH` into the child process `env` (alongside inherited `process.env`); rebuild module after change
- [x] T020 [P] [US2] Create example review script `scripts/review/example-review.sh`: reads diff from stdin, demonstrates the stage contract (exit 0 = pass, exit 1 = fail), includes inline comments explaining the contract; `chmod +x scripts/review/example-review.sh`
- [x] T021 [US2] Add a Code Review stage to `pipeline.config.json` pointing to `scripts/review/example-review.sh` with `"timeout": 60000`; verify `git push` with a diff that triggers failure is blocked and the review output is displayed

**Checkpoint**: US2 fully functional — arbitrary review scripts (linters, AI agents) plug in via `pipeline.config.json`; diff context is available to all stages via stdin and env vars.

---

## Phase 5: User Story 3 — Pipeline Stage Visibility and Reporting (Priority: P3)

**Goal**: Every push attempt shows a structured, readable per-stage summary; full run output is persisted to a local log file for later review.

**Independent Test**: Trigger a pipeline run (pass and fail). Verify: terminal shows a section header per stage with ✓/✗ and duration; failing stage output is shown in full; a summary line shows overall PASSED/FAILED with total duration; `.pipeline-runs.log` contains a new NDJSON line with correct fields after the run.

### Tests for User Story 3 ⚠️ Write FIRST — must FAIL before implementing

- [x] T022 [P] [US3] Write failing unit tests for terminal reporter in `modules/pipeline/test/reporter.test.ts`: stage start prints header; stage pass prints `✓ <name> (<duration>s)`; stage fail prints `✗ <name> (<duration>s) exit code <N>`; timeout prints `⊙ <name> (timeout)`; final summary prints `PIPELINE PASSED` or `PIPELINE FAILED` with total duration; `NO_COLOR=1` suppresses ANSI codes
- [x] T024 [P] [US3] Write failing unit tests for run log writer in `modules/pipeline/test/logger.test.ts`: appends one valid JSON line per call; line contains all `PipelineResult` fields; stage `output` field truncated at 50,000 characters; multiple calls append multiple lines (does not overwrite)

### Implementation for User Story 3

- [x] T023 [US3] Implement terminal reporter in `modules/pipeline/src/reporter.ts`: `reportStageStart(name)`, `reportStageEnd(result: StageResult)`, `reportSummary(result: PipelineResult)` functions; use `━` for stage separators, `═` for summary separator; ✓/✗/⊙ symbols with ANSI color (green/red/yellow); respect `NO_COLOR` env var; exports all three functions
- [x] T025 [US3] Implement run log writer in `modules/pipeline/src/logger.ts`: `appendRunLog(result: PipelineResult, logPath: string): Promise<void>`; serializes result as single JSON line (no embedded newlines); truncates each stage `output` to 50,000 characters before serializing; uses `fs.appendFile` with `\n` delimiter; exports `appendRunLog`
- [x] T026 [US3] Integrate reporter and logger into `modules/pipeline/src/runner.ts` and `modules/pipeline/src/index.ts`: call `reportStageStart` before each stage, `reportStageEnd` after each stage, `reportSummary` after all stages complete; call `appendRunLog` with `.pipeline-runs.log` path after pipeline completes; rebuild module
- [x] T027 [US3] Verify all US3 acceptance scenarios end-to-end: passing push shows per-stage ✓ summary and `PIPELINE PASSED`; failing push highlights failing stage with full output and `PIPELINE FAILED`; `.pipeline-runs.log` has a new entry after each run; log entry contains correct commitSha and stage results

**Checkpoint**: US3 fully functional — developers can read terminal output to diagnose any failure without additional commands, and can inspect `.pipeline-runs.log` for historical runs.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Final validation, documentation, and hardening across all stories.

- [x] T028 [P] Run the full test suite (`pnpm --filter @boring-bot/pipeline run test`) and confirm all tests pass with zero failures
- [x] T029 [P] Run `pnpm --filter @boring-bot/pipeline run build` and confirm TypeScript strict mode reports zero errors
- [x] T030 Validate the quickstart.md setup guide on the current machine: follow each step from a clean state, confirm a new pipeline stage can be added to `pipeline.config.json` and tested in under 10 minutes (SC-004)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately
- **Foundational (Phase 2)**: Depends on Setup — **BLOCKS all user stories**
- **US1 (Phase 3)**: Depends on Foundational — no dependency on US2 or US3
- **US2 (Phase 4)**: Depends on Foundational + US1 (runner must exist to test review stages end-to-end)
- **US3 (Phase 5)**: Depends on Foundational + US1 (runner must exist to integrate reporter/logger)
- **Polish (Phase 6)**: Depends on all user story phases complete

### User Story Dependencies

- **US1 (P1)**: Can start immediately after Phase 2 — no dependency on US2 or US3
- **US2 (P2)**: Requires US1 complete (runner exists); adds env var injection and review script support
- **US3 (P3)**: Requires US1 complete (runner exists); adds reporter and logger on top of existing run

### Within Each User Story

- Tests written FIRST — must demonstrably fail before implementation begins (Constitution Principle V)
- Types/interfaces before implementation
- Core implementation before integration
- Build + end-to-end verification last in each phase

### Parallel Opportunities

- T002, T003, T004 can run in parallel (different files)
- T006, T007 can run in parallel with T002–T004 (different concerns)
- T008 and T010 can run in parallel (different test files)
- T013 (US1 test), T018 (US2 test), T022 (US3 test), T024 (US3 test) can run in parallel once Phase 2 is complete
- T020 (example review script) can run in parallel with T018/T019
- T028 and T029 can run in parallel

---

## Parallel Example: Phase 2 Foundational

```bash
# These two test-writing tasks can run simultaneously:
Task T008: Write config.test.ts (failing)
Task T010: Write stage.test.ts (failing)

# Then implement in parallel:
Task T009: Implement config.ts (makes T008 green)
Task T011: Implement stage.ts (makes T010 green)
```

## Parallel Example: User Story 3

```bash
# Both test files can be written simultaneously:
Task T022: Write reporter.test.ts (failing)
Task T024: Write logger.test.ts (failing)

# Then implement in parallel:
Task T023: Implement reporter.ts (makes T022 green)
Task T025: Implement logger.ts (makes T024 green)
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational — CRITICAL, blocks everything
3. Complete Phase 3: User Story 1
4. **STOP and VALIDATE**: Run a real push with a failing test — confirm it's blocked
5. The pipeline is usable from this point forward

### Incremental Delivery

1. Setup + Foundational → Core engine ready
2. US1 → Tests gate working → `git push` enforced (**MVP**)
3. US2 → Review scripts plugged in → AI agents run on push
4. US3 → Rich terminal output + log file → Full observability
5. Each story adds value without breaking previous stories

### Parallel Team Strategy

With two developers:

1. Both complete Setup + Foundational together
2. Once Phase 2 is done: Developer A takes US1; both unblock US2/US3 once US1 is merged

---

## Notes

- `[P]` = different files, no blocking dependencies between these specific tasks
- `[USN]` = maps task to user story for traceability
- All tests MUST fail before implementation (Constitution Principle V — mandatory, not optional)
- Build `@boring-bot/pipeline` after any source change before testing the hook end-to-end
- The `.husky/pre-push` shell shim must remain <30 lines — all logic lives in TypeScript
- Stage output in `.pipeline-runs.log` is capped at 50,000 characters per stage (data-model constraint)
- `git push --no-verify` bypasses Husky hooks at the git level; this is outside the pipeline's scope
