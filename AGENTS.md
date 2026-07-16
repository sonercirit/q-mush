# AGENTS.md

Living project memory for coding agents. Update it whenever work reveals durable
information.

## Project Snapshot

- Private Bun project using strict TypeScript and ES modules.
- `src/index.ts` is the Bun HTTP server entry point.
- The server-rendered homepage lives at `/`; the browser-rendered app lives at
  `/app`.
- Tests use Bun's built-in test runner.

## Working Agreements

- Inspect the repository and `git status` before changing files.
- Preserve established patterns once they exist; do not introduce a new tool or
  dependency without a concrete need.
- Practice test-driven development (TDD) for behavioral changes: write or update
  a failing test first, implement the minimum needed to pass, then refactor
  while keeping tests green.
- Follow DRY (Don't Repeat Yourself): keep each piece of knowledge or logic in
  one authoritative place, while avoiding premature abstractions.
- Follow KISS (Keep It Simple, Stupid): prefer the simplest clear solution that
  meets the requirements and avoid unnecessary complexity.
- Follow local-first: keep data and core workflows on the user's machine by
  default, with remote services enhancing rather than gating functionality.
- Run the narrowest relevant checks after each change, then broader checks when
  practical.
- Keep changes focused and avoid modifying unrelated files.
- Never commit secrets, credentials, generated artifacts, or local environment
  files.

## Living-Memory Rules

Update this file during the task—not only at the end—when you learn something
future agents should know, including:

- architecture, important directories, and data flow;
- canonical setup, build, lint, test, and run commands;
- conventions that are not obvious from the code;
- consequential decisions and their rationale;
- recurring pitfalls, environment constraints, and known issues.

Keep entries concise and factual. Remove or revise stale notes rather than
accumulating a chronological log. Do not record transient command output,
task-specific progress, guesses, or sensitive values.

## Setup and Commands

- Install dependencies: `bun install`
- Run the application: `bun run src/index.ts`
- Run the development server in watch mode: `bun run dev`
- Run tests: `bun test`
- Check repository constraints: `bun run repository-check`
- Check formatting: `bun run format:check`
- Format files: `bun run format`
- Type-check: `bun run typecheck`
- Check for dead code and dependency issues: `bun run knip`
- Check for duplicate code: `bun run cpd`
- Lint: `bun run lint`
- Apply safe lint fixes: `bun run lint:fix`
- Run all static checks: `bun run check`

## Architecture and Conventions

- Bun manages dependencies through `package.json` and the committed `bun.lock`
  lockfile.
- `src/server.ts` builds `src/client.tsx` and the Tailwind stylesheet in memory
  at startup, then serves them from `/app.js` and `/styles.css`; no generated
  browser assets are written to disk. It precompresses textual response bodies
  once per handler and negotiates `zstd`, Brotli, gzip, or deflate from
  `Accept-Encoding`, in that server-preference order.
- `src/pages.tsx` contains server page markup, while `src/client.tsx` mounts the
  browser app. Shared route paths are defined in `src/routes.ts`.
- `src/auth.ts` implements Google OpenID Connect with an authorization-code +
  PKCE flow. It uses HttpOnly state/verifier cookies, fetches the basic profile,
  discards provider tokens, and keeps seven-day application sessions in memory.
  `src/client.tsx` reads `/api/auth/session`, gates the control center, and
  posts logout to `/api/auth/logout`. All API routes derive from the `/api` base
  path in `src/routes.ts`.
- `src/jsx.ts` is the framework-free classic JSX factory and renders its small
  element tree either to escaped HTML or browser DOM. TSX files must import
  `createElement`; `tsconfig.json` configures it as `jsxFactory`.
- Tailwind CSS v4 is built with `@tailwindcss/cli`; `src/styles.css` is the
  source entry point and limits automatic class detection to `src`.
- `bunfig.toml` requires package releases to be at least one week old before
  installation.
- TypeScript is configured for strict, no-emit, bundler-style checking in
  `tsconfig.json`, including unused and unreachable code diagnostics.
- `eslint.config.ts` uses ESLint flat config with type-aware strict and
  stylistic `typescript-eslint` presets; ESLint loads it through the `jiti`
  development dependency. It imports `.gitignore`, bans non-const type
  assertions, and enforces exhaustive switches and type-only imports.
- `knip.config.ts` checks every issue type and entry exports;
  `knip.production.config.ts` limits the production graph to runtime source.
  `bun run knip` runs both production and comprehensive test/tooling passes, so
  tests cannot keep production code alive while unused test helpers still fail.
- `.jscpd.json` maps all supported JavaScript and TypeScript extensions to the
  TSX format for cross-extension detection; clones of at least 20 tokens and one
  line fail the zero-percent threshold.
- `scripts/repository-check.ts` lists existing tracked and unignored files and
  calls the live APIs in `scripts/check-file-length.ts` and
  `scripts/test-location.ts`. It rejects files reaching 20,000 Unicode code
  points (excluding `bun.lock`) and JavaScript/TypeScript test files outside a
  directory named `test`.
- Prettier wraps Markdown prose at its print width and uses
  `prettier-plugin-organize-imports` to sort, combine, and remove unused
  imports; generated/dependency output ignores come from `.gitignore`, while
  `bun.lock` is ignored separately and formatting is enforced by
  `bun run check`.

## Decisions and Gotchas

- The package is marked private and uses ESM (`"type": "module"`).
- Google login reads `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and the
  optional `GOOGLE_REDIRECT_URI`; both credentials must be present together. The
  default local callback is `http://localhost:3000/api/auth/google/callback`,
  which must be registered exactly on the Google web OAuth client. Never expose
  the client secret to browser code or tracked files.
- Keep HTTP `deflate` zlib-wrapped: `node:zlib`'s `deflateSync` produces the
  interoperable content-coding, while `Bun.deflateSync` produces a raw stream.
- Knip rule severities alone do not activate default-off issue types; keep its
  authoritative included-issue list complete so it can generate every error
  rule.
- Add each new runtime source root and executable entry to
  `knip.production.config.ts`. Add standalone non-TypeScript build entries, such
  as `src/styles.css`, to both Knip configs; keep test files and test-support
  directories out of production project patterns.
- Put every test file under a directory named `test`; the directory may appear
  at any depth, such as `scripts/test` or `apps/control-center/test`.
