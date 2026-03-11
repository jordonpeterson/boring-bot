<!--
SYNC IMPACT REPORT
==================
Version change: [BLANK TEMPLATE] → 1.0.0
Modified principles: N/A (initial ratification — all sections newly defined)
Added sections:
  - Core Principles (I–V)
  - Technology Standards
  - Development Workflow
  - Governance
Removed sections: none
Templates reviewed:
  - .specify/templates/plan-template.md ✅ no changes required (Constitution Check section is dynamic)
  - .specify/templates/spec-template.md ✅ no changes required
  - .specify/templates/tasks-template.md ✅ no changes required (test-first pattern aligns with Principle III)
  - .specify/templates/checklist-template.md ✅ no changes required
  - .specify/templates/agent-file-template.md ✅ no changes required
  - .specify/templates/constitution-template.md ✅ source template, no changes required
Follow-up TODOs: none — all placeholders resolved.
-->

# boring-bot Constitution

## Core Principles

### I. Agent Verification First
AI agents will be doing 100% of the work on this repo. We optimize everything to make it easy for an ai agent in a local
development environment to be able to test, observe, build etc. We make automated tools and linting that are well 
documented for other agents to use. We always verify work with automated tools, tests, typecheck, manual testing,
security review code agents, code review agents etc. We build extensive test plans as part of specs that include
multiple types of review and testing. 

### II. Make every PR ready to review
When creating a PR, always verify that automated code checks pass by monitoring the PR until it completes. Always
include diagrams, succinct explanations etc. to make the PR as easy to review as possible. 

### III. Module-First

Every feature MUST be delivered as an independent `@boring-bot/<name>` package under `modules/`.
Modules MUST be self-contained: they declare their own dependencies in `package.json`,
extend `../../tsconfig.base.json`, expose a public API via `src/index.ts`, and compile
to `dist/` without relying on sibling module internals.

Cross-module coupling MUST be declared explicitly as a `workspace:*` dependency —
implicit shared code is prohibited. No module may exist solely for organizational
grouping; each MUST have a clear, singular purpose.

**Rationale**: Loose coupling enables modules to be independently built, tested, deployed,
and reasoned about. It prevents hidden dependency chains that make refactoring expensive.

### IV. TypeScript Strict Mode

All source code MUST be TypeScript. Every module MUST extend `../../tsconfig.base.json`,
which enforces strict mode. Implicit `any` types are prohibited; explicit `as any` casts
MUST include an inline comment explaining why narrower typing is impractical.

ESM (`"type": "module"`) is the required module format across all packages.

**Rationale**: Strict types surface contract violations at compile time rather than
runtime, which is critical when modules interact across isolation boundaries.

### V. Test-First

Tests MUST be written before implementation code. The red-green-refactor cycle is
mandatory: tests MUST demonstrably fail before the feature is implemented. No PR may
introduce untested production logic (new exported functions, HTTP endpoints, or
container-facing behavior) without a corresponding test.

Unit tests live in `test/` at the module root. Integration tests requiring external
services MUST be gated behind an environment variable (e.g., `RUN_INTEGRATION=1`) so
they do not block the default test run.

**Rationale**: Test-first design forces the public interface to be defined before
implementation details, producing cleaner contracts and catching regressions early.

### VI. Security by Design

Code execution features MUST apply the following controls without exception:

- **Key injection at runtime**: Secrets (e.g., `ANTHROPIC_API_KEY`) are passed at
  container run-time — never baked into Docker images or committed to the repository.
- **Non-root containers**: Runner processes MUST execute as a non-root uid (uid ≥ 1000).
- **Read-only host mounts**: Context directories provided to containers MUST be mounted
  read-only (`:ro`).
- **Resource limits**: Each container MUST be constrained by explicit memory and CPU
  limits. Unbounded containers are prohibited.
- **Minimal network surface**: Containers MUST use bridge networking. Inbound ports
  MUST NOT be exposed unless the feature explicitly requires it.

**Rationale**: boring-bot executes untrusted AI-generated code. Defence-in-depth at
every layer (identity, filesystem, network, resources) limits blast radius if the
agent produces malicious or runaway output.

### VII. Simplicity (YAGNI)

Features MUST be scoped to what is currently required. Abstractions, helpers, and
shared utilities MUST NOT be created for hypothetical future use. Three similar lines
of code are preferable to a premature abstraction. Complexity beyond the minimum
required for the task MUST be justified in writing (plan.md Complexity Tracking table).

**Rationale**: Premature abstraction in a modular monorepo creates invisible coupling
and makes modules harder to replace or delete independently.

## Technology Standards

- **Language**: TypeScript 5.x, strict mode, ESM (`"type": "module"`)
- **Runtime**: Node.js (LTS)
- **Package manager**: pnpm workspaces — no npm or yarn
- **AI SDK**: `@anthropic-ai/claude-agent-sdk` for Claude agent interactions
- **Containerisation**: Docker (Dockerode client) for isolated code execution
- **HTTP layer**: Fastify (where an HTTP interface is needed)
- **Frontend**: Next.js 15 App Router + Supabase + Tailwind CSS v4 (ui module only)
- **Build output**: `dist/` via `tsc`; source in `src/`

Introducing a new runtime dependency in a module requires a comment in the PR
explaining why an existing dependency is insufficient.

## Development Workflow

New modules MUST follow the canonical creation checklist in
`docs/architecture/modules.md`:

1. Create `modules/<name>/src/index.ts`
2. Add `package.json` with scope `@boring-bot/<name>`, `"private": true`, ESM fields
3. Add `tsconfig.json` extending `../../tsconfig.base.json`
4. Run `pnpm install` from the repo root before writing any import statements
5. Add a `test/` directory and at least one test before submitting a PR

Cross-module dependencies MUST be declared as `workspace:*` in `package.json` and
resolved via `pnpm install`. Direct file-path imports across module boundaries are
prohibited.

Build commands:
- All modules: `pnpm -r run build`
- Single module: `pnpm --filter @boring-bot/<name> run build`

## Governance

This constitution supersedes all other written or informal practices. In any conflict
between a convention elsewhere in the codebase and a principle stated here, this
document takes precedence.

**Amendment procedure**: Amendments MUST be proposed as a PR that updates this file.
The PR description MUST explain the principle being changed, the motivation, and any
migration plan for existing code that violates the new rule. The `CONSTITUTION_VERSION`
MUST be incremented per semantic versioning (MAJOR for principle removal/redefinition,
MINOR for additions, PATCH for clarifications).

**Compliance review**: All PRs MUST be reviewed against this constitution. The
plan-template.md "Constitution Check" gate MUST be completed before implementation
begins. Violations require explicit justification in the Complexity Tracking table.

**Version policy**: `CONSTITUTION_VERSION` follows `MAJOR.MINOR.PATCH`. Bump MAJOR
when a principle is removed or its non-negotiable rules are weakened. Bump MINOR when
a new principle or mandatory section is added. Bump PATCH for wording clarifications
with no semantic change.

**Version**: 1.0.0 | **Ratified**: 2026-03-10 | **Last Amended**: 2026-03-10
