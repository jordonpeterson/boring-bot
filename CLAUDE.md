# boring-bot

AI-first modular monorepo using pnpm workspaces and TypeScript.

## Structure

- `modules/` — each subdirectory is an independent package (`@boring-bot/<name>`)
- Each module has its own `package.json`, `tsconfig.json`, and `src/` directory
- Modules are not tightly coupled; cross-module dependencies must be declared explicitly

## Commands

- `pnpm install` — install all dependencies
- `pnpm -r run build` — build all modules
- `pnpm --filter @boring-bot/<name> run build` — build a single module

## Docs

- `docs/` — project documentation (architecture, guides, etc.)

## Conventions

- Package scope: `@boring-bot/*`
- TypeScript strict mode enabled via `tsconfig.base.json`
- Each module extends `../../tsconfig.base.json`
- Source in `src/`, output in `dist/`

## Active Technologies
- TypeScript 5.x, strict mode, ESM (`"type": "module"`) + Node.js LTS built-ins only (`child_process`, `fs/promises`, `readline`); Husky v9 (devDependency at repo root) (001-husky-local-pipeline)
- `pipeline.config.json` (JSON, version-controlled); `.pipeline-runs.log` (NDJSON, gitignored) (001-husky-local-pipeline)

## Recent Changes
- 001-husky-local-pipeline: Added TypeScript 5.x, strict mode, ESM (`"type": "module"`) + Node.js LTS built-ins only (`child_process`, `fs/promises`, `readline`); Husky v9 (devDependency at repo root)
