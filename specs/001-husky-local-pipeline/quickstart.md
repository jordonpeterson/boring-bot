# Quickstart: Local Push Pipeline

**Branch**: `001-husky-local-pipeline` | **Date**: 2026-03-10

---

## Prerequisites

- `git`, `node` (LTS), and `pnpm` installed locally.
- Repository cloned and `pnpm install` run at the repo root.

---

## Setup (one-time)

### 1. Install Husky

```sh
pnpm add -D husky          # adds husky as a devDependency at the root
pnpm exec husky init       # creates .husky/ and adds "prepare": "husky" to package.json
```

### 2. Build the pipeline module

```sh
pnpm --filter @boring-bot/pipeline run build
```

This compiles the TypeScript orchestrator to `modules/pipeline/dist/`.

### 3. Configure the pre-push hook

Replace the generated `.husky/pre-push` with:

```sh
#!/bin/sh
ZERO="0000000000000000000000000000000000000000"

while IFS=' ' read -r local_ref local_sha remote_ref remote_sha; do
  # Skip deletions
  [ "$local_sha" = "$ZERO" ] && continue

  if [ "$remote_sha" = "$ZERO" ]; then
    # New branch: diff against merge-base with main
    base=$(git merge-base HEAD origin/main 2>/dev/null \
           || git rev-list --max-parents=0 HEAD)
    diff_range="${base}..${local_sha}"
  else
    diff_range="${remote_sha}..${local_sha}"
  fi

  git diff "$diff_range" \
    | PIPELINE_COMMIT_SHA="$local_sha" \
      PIPELINE_BRANCH="$local_ref" \
      node modules/pipeline/dist/index.js

  [ $? -ne 0 ] && exit 1
done
```

Make it executable:

```sh
chmod +x .husky/pre-push
```

### 4. Create pipeline.config.json

At the repo root:

```json
{
  "stages": [
    {
      "name": "Tests",
      "command": "pnpm -r run test --if-present",
      "timeout": 120000
    }
  ]
}
```

### 5. Add .pipeline-runs.log to .gitignore

```sh
echo '.pipeline-runs.log' >> .gitignore
```

---

## Daily Use

The pipeline runs automatically on every `git push`. No additional commands needed.

```
$ git push

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
▶  Tests
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
... test output ...
✓  Tests  (4.23s)

═══════════════════════════════════════
PIPELINE PASSED  (4.23s)
═══════════════════════════════════════
```

---

## Adding a New Stage

1. Write a script that reads the git diff from stdin and exits non-zero on failure. See `specs/001-husky-local-pipeline/contracts/stage-contract.md`.
2. Make it executable: `chmod +x path/to/stage.sh`
3. Add an entry to `pipeline.config.json`:
   ```json
   { "name": "Your Stage", "command": "path/to/stage.sh", "timeout": 60000 }
   ```
4. Done. The pipeline picks it up on the next push.

---

## Viewing Past Runs

```sh
# Show the last 5 run results
tail -5 .pipeline-runs.log | while IFS= read -r line; do
  echo "$line" | node -e "
    const r = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    console.log(r.startedAt, r.status.toUpperCase(), r.branch, r.durationMs + 'ms');
  "
done

# Or open the file directly — it's NDJSON (one JSON object per line)
cat .pipeline-runs.log
```

---

## Rebuilding After Changes to the Pipeline Module

If you modify `modules/pipeline/src/`, rebuild before the next push:

```sh
pnpm --filter @boring-bot/pipeline run build
```

The pre-push hook always runs the compiled `dist/index.js`, so a rebuild is required after source changes.
