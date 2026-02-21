# @boring-bot/code-executor

Run Claude agent sessions inside isolated Docker containers and stream the full event log back to the caller.

## Architecture

```
caller → ExecutorService → Docker container → runner/index.ts → @anthropic-ai/claude-agent-sdk
                ↓ SSE / AsyncIterable                              ↓ NDJSON on stdout
         HTTP server (Fastify)                              Anthropic API
```

## Build the Docker image

```bash
pnpm --filter @boring-bot/code-executor run build:docker
```

## Programmatic usage (no HTTP)

```ts
import { ExecutorService } from '@boring-bot/code-executor'

const executor = new ExecutorService({
  getApiKey: async () => process.env.ANTHROPIC_API_KEY!,
})

for await (const event of executor.execute({ prompt: 'What directory are you running in? Tell me just pwd' })) {
  console.log(event)
}
```

## Start the HTTP server

```ts
import { startServer } from '@boring-bot/code-executor'

await startServer({
  authToken: 'my-secret-token',
  port: 3000,
  getApiKey: async () => process.env.ANTHROPIC_API_KEY!,
})
```

## Trigger a run via curl

```bash
curl -N -X POST http://localhost:3000/run \
  -H "Authorization: Bearer my-secret-token" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "List files in /workspace"}'
```

## Replay a run

### Via curl

```bash
curl -N "http://localhost:3000/run/<runId>/replay?realtime=true" \
  -H "Authorization: Bearer my-secret-token"
```

### Programmatically

```ts
import { replayRun } from '@boring-bot/code-executor'

for await (const event of replayRun('/tmp/boring-bot-logs/<runId>.ndjson', { realtime: true })) {
  console.log(event)
}
```

## StreamEvent shape

```ts
// An event from the Claude agent
{ type: 'event'; runId: string; seq: number; ts: number; event: ClaudeEvent }

// An error line from stdout/stderr or the service
{ type: 'error'; runId: string; text: string }

// Run completed
{ type: 'done'; runId: string; exitCode: number; logPath: string }
```

## LangGraph Python consumer

```python
import httpx, json

with httpx.stream(
    "POST", "http://localhost:3000/run",
    headers={"Authorization": "Bearer my-secret-token"},
    json={"prompt": "Analyse the codebase"},
    timeout=None,
) as r:
    for line in r.iter_lines():
        if line.startswith("data: "):
            event = json.loads(line[6:])
            print(event)
```

## Security notes

- **Key injection**: `ANTHROPIC_API_KEY` is passed at container run time via `ExecutorService` — it is never baked into the image.
- **Non-root container**: The runner process runs as uid 1000 (`runner`) to prevent privilege escalation.
- **Read-only context mount**: When `contextPath` is provided, it is mounted at `/workspace/context:ro` so the agent can read but not modify host files.
- **Resource limits**: Each container is constrained to `memoryBytes` (default 1 GiB) and `nanoCpus` (default 2 vCPU).
- **Network isolation**: Containers use `bridge` mode — only outbound connections to the Anthropic API are needed.
