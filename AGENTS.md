# AGENTS.md

Living project memory for coding agents. Update it whenever work reveals durable information.

## Project Snapshot

- Private Bun project using strict TypeScript and ES modules.
- `index.ts` is the application entry point.
- Tests use Bun's built-in test runner.

## Working Agreements

- Inspect the repository and `git status` before changing files.
- Preserve established patterns once they exist; do not introduce a new tool or dependency without a concrete need.
- Practice test-driven development (TDD) for behavioral changes: write or update a failing test first, implement the minimum needed to pass, then refactor while keeping tests green.
- Follow DRY (Don't Repeat Yourself): keep each piece of knowledge or logic in one authoritative place, while avoiding premature abstractions.
- Follow KISS (Keep It Simple, Stupid): prefer the simplest clear solution that meets the requirements and avoid unnecessary complexity.
- Run the narrowest relevant checks after each change, then broader checks when practical.
- Keep changes focused and avoid modifying unrelated files.
- Never commit secrets, credentials, generated artifacts, or local environment files.

## Living-Memory Rules

Update this file during the task—not only at the end—when you learn something future agents should know, including:

- architecture, important directories, and data flow;
- canonical setup, build, lint, test, and run commands;
- conventions that are not obvious from the code;
- consequential decisions and their rationale;
- recurring pitfalls, environment constraints, and known issues.

Keep entries concise and factual. Remove or revise stale notes rather than accumulating a chronological log. Do not record transient command output, task-specific progress, guesses, or sensitive values.

## Setup and Commands

- Install dependencies: `bun install`
- Run the application: `bun run index.ts`
- Run tests: `bun test`
- Check file lengths: `bun run file-length`
- Type-check: `bun run typecheck`
- Check for dead code and dependency issues: `bun run knip`
- Lint: `bun run lint`
- Apply safe lint fixes: `bun run lint:fix`
- Run all static checks: `bun run check`

## Architecture and Conventions

- Bun manages dependencies through `package.json` and the committed `bun.lock` lockfile.
- `bunfig.toml` requires package releases to be at least one week old before installation.
- TypeScript is configured for strict, no-emit, bundler-style checking in `tsconfig.json`, including unused and unreachable code diagnostics.
- `eslint.config.ts` uses ESLint flat config with type-aware strict and stylistic `typescript-eslint` presets; ESLint loads it through the `jiti` development dependency.
- `knip.json` treats every Knip issue type as an error and checks exports from entry files.
- `scripts/check-file-length.ts` checks tracked and unignored files, excluding `bun.lock`; files reaching 20,000 Unicode code points fail with guidance to split or condense them.

## Decisions and Gotchas

- The package is marked private and uses ESM (`"type": "module"`).
- Knip rule severities alone do not activate default-off issue types; keep the explicit `include` list aligned with the `rules` map.
