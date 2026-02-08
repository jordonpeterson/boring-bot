# Modules

## Overview

Each directory under `modules/` is an independent TypeScript package managed by pnpm workspaces. Modules are not tightly coupled — they live in the same repo for convenience but maintain separate dependencies, builds, and entry points.

## Structure

Every module follows this layout:

```
modules/<name>/
├── package.json      # @boring-bot/<name>, own dependencies
├── tsconfig.json     # Extends ../../tsconfig.base.json
└── src/
    └── index.ts      # Entry point
```

## Creating a New Module

1. Create the directory: `mkdir -p modules/<name>/src`
2. Add a `package.json`:
   ```json
   {
     "name": "@boring-bot/<name>",
     "version": "0.0.1",
     "private": true,
     "type": "module",
     "main": "dist/index.js",
     "types": "dist/index.d.ts",
     "scripts": {
       "build": "tsc",
       "clean": "rm -rf dist"
     },
     "devDependencies": {
       "typescript": "^5.7.0"
     }
   }
   ```
3. Add a `tsconfig.json`:
   ```json
   {
     "extends": "../../tsconfig.base.json",
     "compilerOptions": {
       "outDir": "dist",
       "rootDir": "src"
     },
     "include": ["src"]
   }
   ```
4. Add `src/index.ts` as the entry point.
5. Run `pnpm install` from the repo root.

## Cross-Module Dependencies

Modules do not implicitly share code. If module A needs module B, declare it explicitly in module A's `package.json`:

```json
{
  "dependencies": {
    "@boring-bot/other-module": "workspace:*"
  }
}
```

Then run `pnpm install`. This keeps coupling visible and intentional.

## Building

- All modules: `pnpm -r run build`
- Single module: `pnpm --filter @boring-bot/<name> run build`
