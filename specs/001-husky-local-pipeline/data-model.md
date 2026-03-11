# Data Model: Local Push Pipeline with Husky

**Branch**: `001-husky-local-pipeline` | **Date**: 2026-03-10

---

## Entities

### PipelineConfig

Declared in `pipeline.config.json` at the repository root. Loaded once at pipeline startup.

```typescript
interface PipelineConfig {
  stages: StageConfig[];
}

interface StageConfig {
  name: string;       // Display name, e.g. "Tests"
  command: string;    // Shell command to execute, e.g. "pnpm -r run test --if-present"
  timeout: number;    // Milliseconds before the stage is killed, e.g. 120000
}
```

**Validation rules**:
- `stages` must be a non-empty array.
- `name` must be a non-empty string.
- `command` must be a non-empty string.
- `timeout` must be a positive integer (milliseconds).
- No additional properties permitted at the config or stage level.

---

### StageResult

Produced by the runner after each stage execution. Never persisted directly — embedded in PipelineResult.

```typescript
type StageStatus = 'pass' | 'fail' | 'timeout' | 'skipped';

interface StageResult {
  name: string;         // Matches StageConfig.name
  status: StageStatus;
  exitCode: number | null; // null when skipped or killed before exit
  durationMs: number;   // Wall-clock milliseconds; 0 when skipped
  output: string;       // Combined stdout + stderr from the stage process
}
```

**State transitions**:
```
pending → running → pass      (exit code 0)
                  → fail      (exit code non-zero)
                  → timeout   (killed after StageConfig.timeout ms; exit code 124)
pending → skipped              (earlier stage failed; fail-fast)
```

---

### PipelineResult

The aggregate outcome of a single pipeline run. Written to the Run Log after every run.

```typescript
type PipelineStatus = 'pass' | 'fail';

interface PipelineResult {
  runId: string;          // Short identifier: first 8 chars of commitSha + timestamp epoch ms
  commitSha: string;      // Full 40-char SHA of the local commit being pushed
  branch: string;         // Local branch ref, e.g. "refs/heads/feat/my-feature"
  startedAt: string;      // ISO 8601 UTC timestamp
  durationMs: number;     // Total wall-clock time for all stages
  status: PipelineStatus;
  stages: StageResult[];
}
```

---

### RunLog Entry (NDJSON)

Each pipeline run appends one JSON line to `.pipeline-runs.log` (gitignored). The log is append-only; it is never rewritten.

```typescript
// One line in .pipeline-runs.log (serialised PipelineResult)
// Example:
{
  "runId": "a84ffae-1741564800000",
  "commitSha": "a84ffae...",
  "branch": "refs/heads/feat/my-feature",
  "startedAt": "2026-03-10T14:23:45.000Z",
  "durationMs": 16340,
  "status": "fail",
  "stages": [
    { "name": "Tests",       "status": "pass",    "exitCode": 0,    "durationMs": 4230,  "output": "..." },
    { "name": "Code Review", "status": "fail",    "exitCode": 1,    "durationMs": 12110, "output": "..." }
  ]
}
```

**Constraints**:
- Each entry is a single line (no embedded newlines in string values except `\n` escape).
- The `output` field MAY be truncated to a maximum of 50,000 characters per stage to prevent unbounded log growth.
- The log file is appended to via `fs.appendFile`; no locking is required for single-process sequential execution.

---

### DiffInput

The git diff passed to each stage via stdin. Computed once per pipeline run from the pushed ref range.

```typescript
interface DiffInput {
  diffText: string;   // Raw output of: git diff $remote_sha..$local_sha
  commitSha: string;  // The local SHA being pushed
  branch: string;     // The local ref being pushed
}
```

**Computation rules**:
- If `remote_sha` is all zeros (new branch): `git diff $(git merge-base HEAD origin/main)..HEAD`
- If `local_sha` is all zeros (deletion): skip — no pipeline run for deletions.
- Passed to each stage as stdin; also available as environment variables `PIPELINE_COMMIT_SHA` and `PIPELINE_BRANCH` for stages that prefer env access over diff parsing.

---

## File Artifacts

| File | Location | Description |
|------|----------|-------------|
| `pipeline.config.json` | Repo root | Stage declarations; version-controlled |
| `.pipeline-runs.log` | Repo root | Append-only NDJSON run history; gitignored |
| `.husky/pre-push` | Repo root | POSIX shell shim; delegates to `modules/pipeline/dist/index.js` |
| `modules/pipeline/dist/index.js` | Repo root | Compiled pipeline orchestrator entry point |
