import type {
  AgentDefinition,
  JsonSchemaOutputFormat,
  McpServerConfigForProcessTransport,
  Options,
  PermissionMode,
  SandboxSettings,
  SdkBeta,
  SDKMessage,
  SdkPluginConfig,
  SettingSource,
  ThinkingConfig,
} from '@anthropic-ai/claude-agent-sdk'

// Re-export SDK types so consumers don't need to import from two places.
export type {
  AgentDefinition,
  JsonSchemaOutputFormat,
  McpServerConfigForProcessTransport,
  PermissionMode,
  SandboxSettings,
  SdkBeta,
  SDKMessage,
  SdkPluginConfig,
  SettingSource,
  ThinkingConfig,
}

// ────────────────────────────────────────────────────────────────────────────
// CodeExecution — top-level interface for requesting an isolated code run.
// ────────────────────────────────────────────────────────────────────────────

/**
 * The container base image used for code execution.
 *
 * All base images are expected to extend the boring-bot runner image which
 * ships with the Claude Code agent SDK and supporting tooling pre-installed.
 *
 * @example
 * ```ts
 * const image: BaseImage = { name: 'boring-bot-runner:latest' }
 * ```
 */
export interface BaseImage {
  /**
   * Full image name including optional registry prefix and tag.
   *
   * @example 'boring-bot-runner:latest'
   * @example 'ghcr.io/acme/custom-runner:v2'
   */
  name: string
}

/**
 * Configuration for the Claude Code AI agent that powers the execution.
 *
 * Controls model selection, permissions, tool access, thinking behaviour,
 * MCP servers, subagents, plugins, and every other aspect of the Claude Code
 * agent SDK that can be expressed as serialisable configuration.
 *
 * Fields map closely to the
 * {@link https://docs.anthropic.com/en/docs/claude-code/sdk | Claude Code agent SDK Options}
 * so the executor can pass them straight through to `query()`.
 */
export interface AIConfig {
  // ── Authentication ──────────────────────────────────────────────────────

  /**
   * Anthropic API key used to authenticate with the Claude API.
   *
   * This key is injected into the container at launch time and is never
   * persisted in the image or written to disk.
   */
  apiKey: string

  // ── Model ───────────────────────────────────────────────────────────────

  /**
   * Claude model identifier.
   *
   * When omitted the SDK default model is used.
   *
   * @example 'claude-sonnet-4-6'
   * @example 'claude-opus-4-6'
   */
  model?: string

  /**
   * Fallback model used when the primary model is unavailable or errors.
   */
  fallbackModel?: string

  // ── Permissions & safety ────────────────────────────────────────────────

  /**
   * Controls how Claude Code handles tool permission requests.
   *
   * | Mode                   | Behaviour                                        |
   * |------------------------|--------------------------------------------------|
   * | `'default'`            | Prompt for each tool use (standard)              |
   * | `'acceptEdits'`        | Auto-accept file edits; prompt for other tools   |
   * | `'bypassPermissions'`  | Skip all permission checks                       |
   * | `'plan'`               | Planning mode — no tool execution                |
   * | `'dontAsk'`            | Deny anything not pre-approved                   |
   *
   * @default 'default'
   */
  permissionMode?: PermissionMode

  /**
   * Must be `true` when using `permissionMode: 'bypassPermissions'`.
   *
   * This is a deliberate safety gate to prevent accidental permission bypass.
   *
   * @default false
   */
  allowDangerouslySkipPermissions?: boolean

  // ── Limits ──────────────────────────────────────────────────────────────

  /**
   * Maximum number of agentic turns (prompt → response cycles) before the
   * session is stopped.
   */
  maxTurns?: number

  /**
   * Maximum spend in USD for a single execution. The session ends with an
   * `error_max_budget_usd` result if exceeded.
   */
  maxBudgetUsd?: number

  // ── Thinking ────────────────────────────────────────────────────────────

  /**
   * Controls Claude's extended thinking / reasoning behaviour.
   *
   * - `{ type: 'adaptive' }` — Claude decides when and how deeply to think
   *   (Opus 4.6+, recommended).
   * - `{ type: 'enabled', budgetTokens: number }` — Fixed thinking token budget.
   * - `{ type: 'disabled' }` — No extended thinking.
   *
   * @see https://docs.anthropic.com/en/docs/build-with-claude/adaptive-thinking
   */
  thinking?: ThinkingConfig

  /**
   * Controls how much effort Claude puts into its response. Works in
   * concert with adaptive thinking to guide thinking depth.
   *
   * | Level      | Description                          |
   * |------------|--------------------------------------|
   * | `'low'`    | Minimal thinking, fastest responses  |
   * | `'medium'` | Moderate thinking                    |
   * | `'high'`   | Deep reasoning (default)             |
   * | `'max'`    | Maximum effort (Opus 4.6 only)       |
   */
  effort?: 'low' | 'medium' | 'high' | 'max'

  // ── Tools ───────────────────────────────────────────────────────────────

  /**
   * The base set of built-in tools available to the agent.
   *
   * - `string[]` — specific tool names (e.g. `['Bash', 'Read', 'Edit']`).
   * - `[]` (empty) — disable all built-in tools.
   * - `{ type: 'preset', preset: 'claude_code' }` — all default Claude Code tools.
   *
   * When omitted the SDK default tool set is used.
   */
  tools?: string[] | { type: 'preset'; preset: 'claude_code' }

  /**
   * Tools that are auto-allowed without prompting for permission.
   * These bypass the permission flow and execute immediately.
   *
   * @example ['Read', 'Write', 'Bash', 'Edit']
   */
  allowedTools?: string[]

  /**
   * Tools the agent is explicitly forbidden from using. Takes precedence
   * over both `tools` and `allowedTools`.
   */
  disallowedTools?: string[]

  // ── System prompt ───────────────────────────────────────────────────────

  /**
   * System prompt provided to Claude at the start of the session.
   *
   * - Pass a **string** for a fully custom prompt.
   * - Pass the preset object to use the built-in Claude Code system prompt
   *   with optional appended instructions.
   *
   * @example 'You are a backend engineer focused on Go microservices.'
   * @example { type: 'preset', preset: 'claude_code', append: 'Always run tests before committing.' }
   */
  systemPrompt?: string | { type: 'preset'; preset: 'claude_code'; append?: string }

  // ── Skills & settings ───────────────────────────────────────────────────

  /**
   * Filesystem setting sources to load when the session starts.
   *
   * - `'user'`    — global user settings (`~/.claude/settings.json`)
   * - `'project'` — project settings (`.claude/settings.json`)
   * - `'local'`   — local settings (`.claude/settings.local.json`)
   *
   * **Include `'project'`** to load CLAUDE.md files and project-level skills
   * from the repository.
   *
   * When omitted no filesystem settings are loaded (SDK isolation mode).
   *
   * @example ['project']
   * @example ['project', 'local']
   */
  settingSources?: SettingSource[]

  // ── MCP servers ─────────────────────────────────────────────────────────

  /**
   * MCP (Model Context Protocol) server configurations.
   *
   * Keys are server names; values are transport-level configs (stdio, SSE,
   * HTTP, or named SDK server). These are the serialisable subset of MCP
   * configs — in-process SDK server instances are not supported here since
   * the agent runs inside an isolated container.
   *
   * @example
   * ```ts
   * {
   *   'my-server': {
   *     command: 'node',
   *     args: ['./mcp-server.js'],
   *     env: { DB_URL: 'postgres://...' }
   *   }
   * }
   * ```
   */
  mcpServers?: Record<string, McpServerConfigForProcessTransport>

  // ── Agents ──────────────────────────────────────────────────────────────

  /**
   * Name of a defined agent to use as the main conversation thread.
   * The agent must exist in the `agents` map or in the project settings.
   *
   * @example 'code-reviewer'
   */
  agent?: string

  /**
   * Custom subagent definitions available via the Task tool during execution.
   * Keys are agent names referenced in tool calls.
   *
   * @example
   * ```ts
   * {
   *   'test-runner': {
   *     description: 'Runs the test suite and reports results',
   *     prompt: 'You are a test runner. Execute tests and summarise failures.',
   *     tools: ['Read', 'Bash', 'Glob', 'Grep'],
   *     model: 'haiku'
   *   }
   * }
   * ```
   */
  agents?: Record<string, AgentDefinition>

  // ── Plugins ─────────────────────────────────────────────────────────────

  /**
   * SDK plugins to load at session startup. Plugins can provide custom
   * commands, agents, skills, and hooks that extend Claude Code.
   *
   * Currently only local plugins (`{ type: 'local', path: '...' }`) are
   * supported.
   *
   * @example [{ type: 'local', path: './plugins/my-plugin' }]
   */
  plugins?: SdkPluginConfig[]

  // ── Sandbox ─────────────────────────────────────────────────────────────

  /**
   * Sandbox settings controlling file system and network isolation inside
   * the container.
   *
   * @see https://docs.anthropic.com/en/docs/claude-code/settings#sandbox-settings
   */
  sandbox?: SandboxSettings

  // ── Environment ─────────────────────────────────────────────────────────

  /**
   * Additional environment variables injected into the agent process.
   *
   * The Anthropic API key is injected automatically via `apiKey` — do **not**
   * duplicate it here.
   *
   * @example { NODE_ENV: 'test', DATABASE_URL: 'postgres://localhost/mydb' }
   */
  env?: Record<string, string>

  /**
   * Extra directories the agent can access beyond its working directory.
   * Paths should be absolute within the container filesystem.
   */
  additionalDirectories?: string[]

  // ── Output ──────────────────────────────────────────────────────────────

  /**
   * Constrain the agent's final output to match a JSON schema.
   *
   * When specified the agent will produce structured data conforming to the
   * given schema instead of free-form text.
   *
   * @example
   * ```ts
   * { type: 'json_schema', schema: { type: 'object', properties: { summary: { type: 'string' } } } }
   * ```
   */
  outputFormat?: JsonSchemaOutputFormat

  // ── Advanced ────────────────────────────────────────────────────────────

  /**
   * SDK beta features to enable.
   *
   * @example ['context-1m-2025-08-07']
   */
  betas?: SdkBeta[]

  /**
   * Enable file change tracking for rollback support.
   *
   * When enabled, files can be rewound to their state at any previous user
   * message using `Query.rewindFiles()`.
   *
   * @default false
   */
  enableFileCheckpointing?: boolean

  /**
   * Whether to persist the session to disk so it can be resumed later.
   *
   * Set to `false` for ephemeral or automated workflows where session
   * history is not needed.
   *
   * @default true
   */
  persistSession?: boolean

  /**
   * Include partial / streaming message events in the output stream.
   *
   * When `true`, `SDKPartialAssistantMessage` events are emitted during
   * generation, enabling real-time streaming UIs.
   *
   * @default false
   */
  includePartialMessages?: boolean
}

/** Credentials for authenticating private repository clones. */
export interface RepoCredentials {
  /**
   * Personal access token (GitHub PAT, GitLab token, Bitbucket app password, etc.)
   * Used for HTTPS clones by injecting into the URL as `oauth2:<token>@<host>`.
   * The token is stripped from the stored remote URL immediately after cloning.
   */
  token?: string
}

/**
 * Controls what git operations the agent may perform on a cloned repository.
 * - `'write'` (default): full access including push.
 * - `'read'`: push is disabled at the git remote level after clone.
 */
export type RepoAccess = 'read' | 'write'

/**
 * Configuration for a single repository to be cloned into the agent workspace.
 *
 * @example Public repo, full access
 * ```ts
 * { url: 'https://github.com/owner/my-repo' }
 * ```
 *
 * @example Private repo, read-only
 * ```ts
 * {
 *   url: 'https://github.com/owner/private-repo',
 *   access: 'read',
 *   credentials: { token: process.env.GH_TOKEN! },
 * }
 * ```
 */
export interface RepoConfig {
  /** HTTPS repository URL. */
  url: string

  /**
   * Branch or tag to check out after cloning.
   * Defaults to the remote's default branch.
   */
  branch?: string

  /**
   * Destination path relative to `/workspace`.
   * Defaults to the repository name derived from the URL
   * (last path segment with `.git` stripped).
   *
   * @example 'my-repo'  →  /workspace/my-repo
   */
  path?: string

  /**
   * Access level granted to the agent for this repository.
   * @default 'write'
   */
  access?: RepoAccess

  /** Authentication credentials for private repositories. */
  credentials?: RepoCredentials

  /**
   * Shallow clone depth.
   * Omit for a full clone.
   *
   * @example 1  →  git clone --depth 1 ...
   */
  depth?: number
}

/**
 * Repository setup configuration.
 *
 * Defines how the repository should be prepared before the AI agent begins
 * work. You can reference a setup script already committed to the repo,
 * provide inline commands, or both.
 *
 * When both `scriptPath` and `commands` are specified, the script runs
 * first, followed by the inline commands.
 *
 * @example Script in the repository
 * ```ts
 * { scriptPath: '.boring-bot/setup.sh' }
 * ```
 *
 * @example Inline commands
 * ```ts
 * { commands: ['pnpm install', 'pnpm run build'] }
 * ```
 *
 * @example Combined
 * ```ts
 * {
 *   scriptPath: './scripts/bootstrap.sh',
 *   commands: ['pnpm run db:migrate']
 * }
 * ```
 */
export interface RepoSetup {
  /**
   * Path to the repository relative to `/workspace`.
   * Defaults to the workspace root (`/workspace`).
   * Matches `RepoConfig.path` so a cloned repo and its setup entry pair naturally.
   * @example 'backend'  →  /workspace/backend
   */
  path?: string

  /**
   * The base branch to create `branchName` from when it does not yet exist.
   * @default HEAD of the current checkout
   */
  baseBranch?: string

  /**
   * Branch for the agent to work on.
   * Strategy: `git checkout branchName` first; if absent, `git checkout -b branchName [baseBranch]`.
   * Omit to leave the current branch unchanged.
   */
  branchName?: string

  /**
   * Path to a setup script within the repository.
   *
   * The path is relative to the repository root. The script is executed
   * inside the container before any inline `commands`.
   *
   * @example '.boring-bot/setup.sh'
   * @example 'scripts/bootstrap.sh'
   */
  scriptPath?: string

  /**
   * Inline shell commands to execute in order.
   *
   * Each command is run sequentially inside the container working directory.
   * If a command exits with a non-zero status the remaining commands are
   * skipped and the execution fails.
   *
   * @example ['pnpm install', 'pnpm run build']
   */
  commands?: string[]
}

/**
 * Configuration for a single isolated code execution run.
 *
 * `CodeExecution` is the top-level input you pass to the executor to
 * describe **what** should happen: which repository branch to work on,
 * which container image to use, how the AI agent should be configured,
 * and any setup steps required before the agent starts.
 *
 * @example Minimal usage
 * ```ts
 * const execution: CodeExecution = {
 *   baseImage: { name: 'boring-bot-runner:latest' },
 *   aiConfig: { apiKey: process.env.ANTHROPIC_API_KEY! },
 * }
 * ```
 *
 * @example Multi-repo execution with per-repo branch setup
 * ```ts
 * const execution: CodeExecution = {
 *   baseImage: { name: 'ghcr.io/acme/runner:v2' },
 *   aiConfig: {
 *     apiKey: process.env.ANTHROPIC_API_KEY!,
 *     model: 'claude-sonnet-4-6',
 *     permissionMode: 'acceptEdits',
 *   },
 *   repos: [
 *     { url: 'https://github.com/acme/frontend', path: 'frontend' },
 *     { url: 'https://github.com/acme/backend',  path: 'backend' },
 *   ],
 *   setupRepos: [
 *     {
 *       path: 'frontend',
 *       branchName: 'feat/add-login-page',
 *       baseBranch: 'main',
 *       commands: ['pnpm install'],
 *     },
 *     {
 *       path: 'backend',
 *       branchName: 'feat/add-login-page',
 *       commands: ['go mod download'],
 *     },
 *   ],
 * }
 * ```
 */
export interface CodeExecution {
  /**
   * The container base image for this execution.
   *
   * The image must extend the boring-bot runner base which includes the
   * Claude Code agent SDK and required tooling.
   */
  baseImage: BaseImage

  /**
   * AI agent configuration controlling the Claude Code session.
   *
   * This is where you set the API key, model, permissions, tools, system
   * prompt, MCP servers, subagents, and all other Claude Code agent SDK
   * options.
   */
  aiConfig: AIConfig

  /**
   * Per-repository setup steps (branch checkout, scripts, commands) executed
   * before the agent starts. Each entry pairs with a cloned repo via `path`.
   */
  setupRepos?: RepoSetup[]

  /**
   * Repositories to clone into the agent workspace before execution begins.
   * Each repo is cloned to `/workspace/<name>` (or a custom `path`).
   */
  repos?: RepoConfig[]
}

// ────────────────────────────────────────────────────────────────────────────
// Internal executor types — used by ExecutorService and the container runner.
// ────────────────────────────────────────────────────────────────────────────

// The serializable subset of Options that can be JSON-encoded into CLAUDE_RUN_CONFIG.
// Mirrors the query() params shape directly so the runner can spread it straight in.
type SerializableOptions = Pick<Options, 'cwd' | 'allowedTools' | 'maxTurns' | 'permissionMode' | 'resume'>

// Passed to the runner container via CLAUDE_RUN_CONFIG env var (JSON-serialised).
// Shaped like query() params so the runner can call query({ prompt, options }) directly.
export interface RunnerConfig {
  prompt: string
  /** Repos to clone before the agent starts. Serialised from CodeExecution. */
  repos?: RepoConfig[]
  /** Repo checkout/setup config. Serialised from CodeExecution. */
  setupRepos?: RepoSetup[]
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
  | { type: 'done';  runId: string; exitCode: number; logPath: string }

/**
 * A single file to place inside `/workspace/context/` before the agent starts.
 *
 * The executor materialises these into a temporary directory that is bind-mounted
 * read-only into the container. The agent can discover and read them at will but
 * cannot modify them.
 *
 * @example
 * ```ts
 * { path: 'spec.md', content: '# Task\nFix the login bug described below...' }
 * { path: 'schema/users.sql', content: 'CREATE TABLE users (...)' }
 * ```
 */
export interface ContextFile {
  /**
   * Destination path relative to `/workspace/context/`.
   * Must be non-empty, relative (no leading `/`), and resolve to a location
   * inside the context directory. For example `'foo/../bar.md'` is valid
   * (stays inside the directory), while `'../../etc/passwd'` is not.
   * Parent directories are created automatically.
   * @example 'spec.md'
   * @example 'schema/users.sql'
   */
  path: string

  /** File content as a UTF-8 string. */
  content: string
}

// Options for ExecutorService.execute()
export interface ExecuteOptions {
  prompt: string
  resume?: string           // maps to Options.resume — session ID to continue
  allowedTools?: string[]
  maxTurns?: number
  permissionMode?: PermissionMode
  /**
   * Files to place in `/workspace/context/` before the agent starts.
   * The executor writes them to a temporary directory and bind-mounts it
   * read-only into the container. Takes precedence over `contextPath`.
   */
  contextFiles?: ContextFile[]
  /**
   * Absolute host path to mount read-only at `/workspace/context/`.
   * Use `contextFiles` instead when content is available programmatically.
   */
  contextPath?: string
  /** Repos to clone into the container workspace before the agent starts. */
  repos?: RepoConfig[]
  /** Repo checkout/setup to perform before the agent starts. */
  setupRepos?: RepoSetup[]
}

// Constructor config for ExecutorService.
export interface ExecutorServiceConfig {
  image?: string        // default: 'boring-bot-runner:latest'
  logDir?: string       // default: '/tmp/boring-bot-logs'
  memoryBytes?: number  // default: 1 GiB
  nanoCpus?: number     // default: 2 vCPU (2e9)
  /** Called at container launch time — never store the key in the image */
  getApiKey: () => Promise<string>
}

// Extends ExecutorServiceConfig for the HTTP server.
export interface ServerConfig extends ExecutorServiceConfig {
  authToken: string
  host?: string
  port?: number
}
