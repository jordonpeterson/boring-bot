# Research: Local Push Pipeline with Husky

**Branch**: `001-husky-local-pipeline` | **Date**: 2026-03-10

---

## 1. Husky v9 Pre-Push Hook Mechanics

**Decision**: Use the `pre-push` git hook with a POSIX shell shim in `.husky/pre-push` that reads git's stdin and delegates to the TypeScript pipeline orchestrator.

**Rationale**: Git passes pushed refs to the pre-push hook via stdin, one line per ref, in the format:
```
<local-ref> <local-sha1> <remote-ref> <remote-sha1>
```
Any non-zero exit from the hook aborts the push. For new branches, `remote-sha1` is all zeros (`0000000000000000000000000000000000000000`). Husky v9 uses plain POSIX shell scripts in `.husky/` — there is no JSON config format.

**Alternatives considered**:
- Pre-receive (server-side) hook: rejected — requires server access, violates offline-only requirement.
- Pre-commit hook: rejected — runs before push info is available; cannot compute pushed diff.

---

## 2. Husky v9 Setup in pnpm Monorepo

**Decision**: Install Husky at the monorepo root only. Init with `pnpm exec husky init`, which creates `.husky/` at the root and adds `"prepare": "husky"` to the root `package.json`.

**Rationale**: Git only consults the root `.git/hooks/` directory; per-package hooks are not possible. The prepare script re-installs hooks on every `pnpm install`. For CI environments that skip devDeps, use `"prepare": "husky || true"` to prevent failures.

**Alternatives considered**:
- Lefthook / simple-git-hooks: rejected — adds an additional tool when Husky is already standard and well-understood in the ecosystem.

---

## 3. Computing the Git Diff for Pushed Commits

**Decision**: Parse pre-push stdin and compute the diff range as `$remote_sha..$local_sha` for existing branches, or `$(git merge-base HEAD origin/main)..HEAD` for new branches (where remote SHA is all zeros).

**Rationale**: The `..` (double-dot) range returns all commits reachable from `local_sha` but not from `remote_sha` — exactly the commits being pushed. The full diff is piped via stdin to each review stage script.

```sh
# In .husky/pre-push:
ZERO_SHA="0000000000000000000000000000000000000000"
while IFS=' ' read -r local_ref local_sha remote_ref remote_sha; do
  [ "$local_sha" = "$ZERO_SHA" ] && continue  # deletion, skip
  if [ "$remote_sha" = "$ZERO_SHA" ]; then
    base=$(git merge-base HEAD origin/main 2>/dev/null || git rev-list --max-parents=0 HEAD)
    diff_range="${base}..${local_sha}"
  else
    diff_range="${remote_sha}..${local_sha}"
  fi
done
```

**Alternatives considered**:
- Three-dot (`...`) range: rejected — shows symmetric difference, which includes commits on the remote branch not on the local branch; not what we want.
- `git diff --name-only`: useful for file lists, but full diff is needed for AI review stages.

---

## 4. Node.js Child Process with Configurable Timeout

**Decision**: Use `child_process.spawn` with the `AbortController` pattern (Node 15+) for timeout management. On timeout, send `SIGTERM` then `SIGKILL` after a 5-second grace period. Use `detached: true` and `process.kill(-pid, signal)` on macOS/Linux to kill the entire process tree.

**Rationale**: `AbortController` is the cleanest async pattern for cancellation. The `detached: true` + negative PID pattern kills child subprocesses (e.g., a shell spawning an AI agent) rather than just the immediate process.

```typescript
import { spawn } from 'child_process';

function runWithTimeout(command: string, timeoutMs: number, stdin: string): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const [cmd, ...args] = command.split(' ');
    const proc = spawn(cmd, args, {
      signal: controller.signal,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    proc.stdin.write(stdin);
    proc.stdin.end();

    let output = '';
    proc.stdout.on('data', (d) => { output += d; });
    proc.stderr.on('data', (d) => { output += d; });

    proc.on('close', (code, signal) => {
      clearTimeout(timer);
      if (signal === 'SIGTERM') resolve({ exitCode: 124, output }); // timeout sentinel
      else resolve({ exitCode: code ?? 1, output });
    });

    proc.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (err.name === 'AbortError') {
        try { process.kill(-(proc.pid!), 'SIGTERM'); } catch {}
        setTimeout(() => { try { process.kill(-(proc.pid!), 'SIGKILL'); } catch {} }, 5000);
        resolve({ exitCode: 124, output }); // timeout
      } else {
        reject(err);
      }
    });
  });
}
```

**Alternatives considered**:
- `spawn({ timeout })` option: simpler but less control over process tree cleanup.
- `execFile`: lacks streaming I/O needed for AI agent output; buffers entire output in memory.

---

## 5. pnpm Test Invocation Across Workspaces

**Decision**: `pnpm -r run test --if-present`

**Rationale**: `-r` (recursive) runs the `test` script in all workspace packages in topological order. `--if-present` silently skips packages without a `test` script, preventing non-zero exit when some modules lack tests. This is the official pnpm pattern for monorepo-wide test execution.

**Alternatives considered**:
- `pnpm -r --parallel run test --if-present`: parallel execution ignores topological order; may cause false failures if modules depend on each other's outputs.
- Per-package filter: overly specific; new modules must be explicitly listed.

---

## 6. Pipeline Config Schema

**Decision**: Minimal JSON schema with three required fields per stage: `name`, `command`, `timeout`. No optional fields in v1 (YAGNI).

```json
{
  "stages": [
    { "name": "Tests", "command": "pnpm -r run test --if-present", "timeout": 120000 },
    { "name": "Code Review", "command": "./scripts/review/code-review.sh", "timeout": 300000 }
  ]
}
```

**Rationale**: Every field beyond (name, command, timeout) must be justified by a concrete requirement. The spec does not require `enabled`, `env`, or `workingDirectory` fields. They can be added via schema versioning when needed.

**Alternatives considered**:
- YAML: more human-readable but requires a parser dependency; JSON is parseable natively.
- Extended schema with `enabled`, `env`, `workingDirectory`: deferred — no current requirement.

---

## 7. Run Log Format

**Decision**: Newline-Delimited JSON (NDJSON). One JSON object per line, appended after each run.

**Rationale**: NDJSON is the industry standard for append-only log files (used by Datadog, Elasticsearch, BigQuery). It supports: (a) human readability (`tail -20 .pipeline-runs.log`), (b) programmatic streaming parse without loading the full file, (c) O(1) appends without reading existing content. Each run entry includes timestamp, commitSha, branch, overall status, total duration, and per-stage summaries.

**Alternatives considered**:
- Plain text with `====` separators: poor programmatic parsing; cannot query by field.
- Standard JSON array: requires rewriting entire file to append; fails on large logs.

---

## 8. Terminal Output Format

**Decision**: Section headers with Unicode separators, ✓/✗/⊙ status symbols, duration in seconds. Respect `NO_COLOR` env var.

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
▶  Tests
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[stage output here]
✓  Tests  (4.23s)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
▶  Code Review
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[stage output here]
✗  Code Review  (12.1s)  exit code 1

═══════════════════════════════════════
PIPELINE FAILED  (16.3s)
═══════════════════════════════════════
```

**Rationale**: Section headers matching GitHub Actions conventions improve developer familiarity. Symbols are faster to scan than words. Duration gives immediate feedback on slow stages (especially relevant for AI agents).

**Alternatives considered**:
- Verbose per-line timestamps: adds noise without value (timestamps are in the log file).
- Progress bars: unnecessary; AI agent stages can stream their own output.
