import type { SDKMessage, Options, PermissionMode } from '@anthropic-ai/claude-agent-sdk'

// Re-export SDK types so consumers don't need to import from two places.
export type { SDKMessage, PermissionMode }

// The serializable subset of Options that can be JSON-encoded into CLAUDE_RUN_CONFIG.
// Mirrors the query() params shape directly so the runner can spread it straight in.
type SerializableOptions = Pick<Options, 'cwd' | 'allowedTools' | 'maxTurns' | 'permissionMode' | 'resume'>

// Passed to the runner container via CLAUDE_RUN_CONFIG env var (JSON-serialised).
// Shaped like query() params so the runner can call query({ prompt, options }) directly.
export interface RunnerConfig {
  prompt: string
  options?: SerializableOptions
}

// Envelope that wraps every line the runner writes to stdout.
export interface RunEnvelope {
  seq: number   // monotonically increasing per run
  ts: number    // Date.now() at emit time
  event: SDKMessage
}

// Union of everything the service can emit to a caller.
export type StreamEvent =
  | { type: 'event'; runId: string; seq: number; ts: number; event: SDKMessage }
  | { type: 'error'; runId: string; text: string }
  | { type: 'done';  runId: string; exitCode: number; logPath: string; agentDir: string }

// Options for ExecutorService.execute()
export interface ExecuteOptions {
  prompt: string
  resume?: string           // maps to Options.resume — session ID to continue
  allowedTools?: string[]
  maxTurns?: number
  permissionMode?: PermissionMode
  /**
   * Absolute host path to use as the agent's writable workspace.
   * Mounted at /workspace inside the container — the agent cannot access
   * anything above this directory. Auto-created per run if not provided.
   */
  agentDir?: string
  /** Absolute host path to mount read-only at /workspace/context */
  contextPath?: string
}

// Auth credentials injected into the runner container at launch time.
export type Credentials =
  | { type: 'api_key';     value: string }
  | { type: 'oauth_token'; value: string }

// Constructor config for ExecutorService.
export interface ExecutorServiceConfig {
  image?: string        // default: 'boring-bot-runner:latest'
  logDir?: string       // default: '/tmp/boring-bot-logs'
  memoryBytes?: number  // default: 1 GiB
  nanoCpus?: number     // default: 2 vCPU (2e9)
  /** Called at container launch time — never store credentials in the image */
  getCredentials: () => Promise<Credentials>
}

// Extends ExecutorServiceConfig for the HTTP server.
export interface ServerConfig extends ExecutorServiceConfig {
  authToken: string
  host?: string
  port?: number
}
