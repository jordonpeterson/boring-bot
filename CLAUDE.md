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
