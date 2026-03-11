# Stage Contract

**Feature**: Local Push Pipeline with Husky (`001-husky-local-pipeline`)
**Date**: 2026-03-10

---

## Overview

A **stage** is any executable script or binary that the pipeline invokes as a unit of work. The pipeline treats all stages — whether a conventional linter, a static analysis tool, or an AI/LLM-based code review agent — as black boxes conforming to this contract. The pipeline does not care how a stage works internally; it only observes the contract below.

---

## Contract

### Input

| Channel | Content |
|---------|---------|
| **stdin** | Full `git diff` output of all commits being pushed (UTF-8 text) |
| `PIPELINE_COMMIT_SHA` env | 40-character SHA of the local commit being pushed |
| `PIPELINE_BRANCH` env | Local ref being pushed, e.g. `refs/heads/feat/my-feature` |

The diff is the output of `git diff $remote_sha..$local_sha`. Stages that only need file names may run `git diff --name-only` internally using `PIPELINE_COMMIT_SHA`.

### Output

| Channel | Content |
|---------|---------|
| **stdout** | Human-readable feedback (shown to the developer on failure; captured in run log always) |
| **stderr** | Errors or diagnostics (combined with stdout for display and logging) |

### Exit Code

| Exit Code | Meaning |
|-----------|---------|
| `0` | Stage passed — no issues found |
| Non-zero | Stage failed — push is blocked; stdout/stderr is shown to the developer |
| `124` | Reserved by the pipeline for timeout; stages MUST NOT exit with code 124 |

### Timeout

The pipeline enforces the per-stage `timeout` value from `pipeline.config.json`. When exceeded, the stage process tree is killed (`SIGTERM` → 5s grace → `SIGKILL`) and the stage is marked `timeout` (equivalent to failure). The push is blocked.

---

## Guarantees Made by the Pipeline

- The pipeline writes the full diff to stdin before calling the stage, then closes stdin (`EOF`).
- `PIPELINE_COMMIT_SHA` and `PIPELINE_BRANCH` are always set in the stage's environment.
- The stage's working directory is the repository root.
- The stage's stdout and stderr are streamed to the terminal in real time and captured for the run log.
- If the stage binary/script is not found or not executable, the pipeline fails with a descriptive error before running any stage.

---

## Guarantees NOT Made by the Pipeline

- The pipeline does not sandbox stages. Stages run with the same permissions as the developer.
- The pipeline does not retry failed stages.
- The pipeline does not pass any information about previous stages to subsequent stages.

---

## Example: Minimal Passing Stage (shell)

```sh
#!/bin/sh
# A stage that always passes. Reads stdin (diff) and exits 0.
cat > /dev/null
exit 0
```

## Example: Conventional Linter Stage

```sh
#!/bin/sh
# Run ESLint on changed TypeScript files.
# Ignores stdin (diff); uses PIPELINE_COMMIT_SHA to determine changed files.
changed=$(git diff --name-only "${PIPELINE_COMMIT_SHA}^" "${PIPELINE_COMMIT_SHA}" -- '*.ts')
[ -z "$changed" ] && exit 0
echo "$changed" | xargs pnpm exec eslint
```

## Example: AI Review Agent Stage

```sh
#!/bin/sh
# Pipe the diff to a Claude-based review agent.
# The agent reads the diff from stdin and exits non-zero if issues are found.
cat | node scripts/review/claude-review-agent.js
```

---

## Adding a New Stage

1. Write a script conforming to this contract (reads stdin, exits 0 on pass, non-zero on fail).
2. Make it executable: `chmod +x path/to/your-stage.sh`.
3. Add an entry to `pipeline.config.json`:
   ```json
   { "name": "Your Stage", "command": "path/to/your-stage.sh", "timeout": 60000 }
   ```
4. Run `git push` to test. No other pipeline files need to change.
