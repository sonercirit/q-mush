# AGENTS.md

Living project memory for coding agents. Update it whenever work reveals durable
information.

## Project Snapshot

- Private strict-TypeScript ESM Bun project.
- `src/index.ts` is the Bun HTTP server entry point.
- The server-rendered homepage lives at `/`; the browser-rendered app lives at
  `/app`.
- Tests use Bun's built-in test runner.

## Working Agreements

- Inspect the repository and `git status` before edits.
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
- Keep changes focused; do not modify unrelated files.
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
- Run: `bun run src/index.ts`
- Develop: `bun run dev`; restart: `bun run dev:restart`
- Generate a database migration after schema changes: `bun run db:generate`
- Apply pending database migrations: `bun run db:migrate`
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
- CI runs tests and static checks on every push through
  `.github/workflows/checks.yml` using Bun 1.3.14 and a frozen lockfile.

## Architecture and Conventions

- Bun manages dependencies through the committed `package.json` and `bun.lock`.
- `src/server.ts` serves the browser JavaScript and Tailwind CSS. Browser state,
  session updates, and runner work use authenticated WebSockets at
  `/api/realtime` and `/api/runner/realtime`; there is no polling or SSE
  application transport. Because agents may modify this repository through the
  running app, `bun run dev` does not restart for source edits. `scripts/dev.ts`
  watches only the ignored `data/development-server.restart` trigger written by
  `bun run dev:restart`. `src/runner-executable.ts` fingerprints the runner
  source and compiler, builds in a private temporary directory, caches it in
  memory, and serves it from `/runner/executable`. Triggered development
  restarts reject new agent work, let active sessions finish, then replace the
  server process, so a session can safely request its own restart. Textual
  response bodies are precompressed once per handler, with `zstd`, Brotli, gzip,
  or deflate negotiated in that server-preference order.
- `src/pages.tsx` contains server page markup, while `src/client.tsx` mounts the
  browser app. Shared route paths are defined in `src/routes.ts`.
- `src/auth.ts` implements Google OpenID Connect with an authorization-code +
  PKCE flow. It uses HttpOnly state/verifier cookies, fetches the basic profile,
  and discards provider tokens. `src/auth-store.ts` uses Drizzle with Bun SQLite
  to upsert users and persist seven-day sessions in the tables defined by
  `src/database/schema.ts`. Application primary keys are UUIDv7 values; Google
  subjects and session cookie tokens are separate unique fields. Every
  application table has creation/update timestamps, actor IDs, and an
  `isDeleted` soft-delete flag. `src/database.ts` applies committed `drizzle/`
  migrations when opening a connection. `src/index.ts` injects the persistent
  connection; the auth factory falls back to isolated in-memory SQLite when a
  connection is not supplied. Shared PKCE, provider parsing, and redirect logic
  lives in `src/oauth.ts`, while shared cookie and response helpers live in
  `src/http.ts`. `src/client.tsx` reads `/api/auth/session`, gates the control
  center, and posts logout to `/api/auth/logout`. All API routes derive from the
  `/api` base path in `src/routes.ts`.
- `src/runner-store.ts` persists any number of user runner registrations, with
  `runners`, with one active registration per machine fingerprint and one
  default runner per user. New sessions use the default online runner or the
  first one. `src/runners.ts` issues hashed opaque setup tokens, owns
  authenticated management and token-authenticated callback APIs, and derives
  installer commands from the request origin. `src/runner-installer.ts` emits
  the macOS/Linux one-line installer; it selects an x64/ARM64 and glibc/musl
  target, downloads one standalone executable, and starts it under
  `~/.q-mush/runner` by default without requiring Bun on that computer. The
  runner reports metadata and 15-second heartbeats on its authenticated
  WebSocket and checks for updates at startup and every five minutes. Its
  handshake version triggers update checks after server restarts; reconnecting
  replaces an older socket for the same runner. Updates use a source/compiler
  ETag and SHA-256 digest, atomically replace the executable, and restart it.
  Development restarts drain active sessions first. The browser panel/controller
  online presence. Reinstalling for the same user and machine rotates the
  existing registration to the new token instead of creating a second runner;
  another user's registration remains protected. Runner tokens never appear in
  list responses.
- `src/sessions.ts` and `src/session-store.ts` implement persistent first-party
  coding sessions. User messages support selecting or pasting up to eight 10 MB
  PNG, JPEG, GIF, or WebP images, persisted with the transcript and sent as
  native multimodal input. A session records latest input-token usage and its
  discovered context limit. Usage shows a percentage, yellow at 80%, and red at
  90%. Auto-compaction defaults on and summarizes completed history before the
  next request at 95%; idle sessions can compact manually. Compaction
  soft-deletes prior active messages and inserts a replayable handoff. Provider
  secrets never enter browser or runner work payloads. The working-directory
  field opens the interactive browser in `src/directory-picker-client.tsx`; its
  controller posts to `/api/runners/:id/directories` for canonical directory
  metadata. Before each run, `read_agent_file` loads exact-root `AGENTS.md`,
  falling back to `CLAUDE.md`; only `AGENTS.md` is used when both exist.

  `src/runner-workspace.ts` shares canonical workspace resolution and
  containment with the file tools. The latest agent-file selection is persisted
  on the session and appended to the model system prompt.
  `src/session-transcript.tsx` renders that effective prompt and the complete
  tool definitions plus the raw arguments, call ID, name, and result for each
  tool entry. It renders Markdown, colorized code/JSON, and context-aware shell,
  read, and parallel results. The control center creates, inspects, follows up,
  continues without appending a user message, stops, and receives live sessions
  through `src/realtime-client.ts`, `src/session-client.tsx`, and
  `src/session-controller.ts`. Unchanged snapshots suppress render
  notifications. Browser rendering preserves the document viewport and keyed
  `data-scroll-key` regions across full-root remounts; the session transcript
  starts at the bottom and returns there when its message or agent-file revision
  changes. It defers remounts while a select has focus, flushing on change or
  focus loss. `src/agent-model-discovery.ts` queries the selected credential's
  provider for compatible models, modalities, and reasoning metadata;
  `src/agent-configuration.ts` owns shared catalog types, efforts, and
  fallbacks. New sessions use the default online runner and model credential,
  each falling back to the first entry. The working directory uses the latest
  session; provider models use the first option and reasoning the maximum
  effort. Model choices show all provider and Q Mush-supported input/output
  modalities. Controls use the listbox in `src/custom-select.tsx`; model options
  show discovered context limits. Model and effort selections are persisted with
  the session. `src/agent-prompt.ts` is the shared source for building the model
  system prompt and its transcript display. Provider reasoning summaries persist
  as `thinking` transcript messages but are excluded from replay. Session and
  transcript rows live in `agent_sessions` and `agent_messages`; an interrupted
  server process marks active sessions failed so they can be resumed explicitly.
  Rebuilt conversations synthesize visible error results for interrupted tool
  calls only on resume, keeping transcript and provider history complete.

- `src/openai.ts` and `src/openrouter.ts` implement provider connections.
  Multiple OAuth or manual credentials live in `provider_credentials`, encrypted
  with per-record AES-256-GCM context; API responses expose only metadata. One
  OpenAI or OpenRouter credential may be the user's model default across both
  providers. Shared behavior is in `src/provider-credentials.ts`,
  `src/connected-account-oauth.ts`, `src/provider-client.tsx`, and
  `src/provider-controller.ts`.
- `src/brave-search.ts` implements the authenticated server-side `brave_search`
  skill and key API. Users can keep multiple encrypted keys in
  `provider_credentials`; failures fall through keys in creation order, and
  secrets never reach the browser, runner, or model provider. Its UI reuses the
  shared credential panel and controller.
- `src/jsx.ts` is the framework-free classic JSX factory and renders its small
  element tree either to escaped HTML or browser DOM. TSX files must import
  `createElement`; `tsconfig.json` configures it as `jsxFactory`.
- Tailwind CSS v4 is built with `@tailwindcss/cli`; `src/styles.css` is the
  source entry point and limits automatic class detection to `src`.
- `bunfig.toml` requires package releases to be at least one week old before
  installation.
- TypeScript is configured for strict, no-emit, bundler-style checking in
  `tsconfig.json`, including unused and unreachable code diagnostics. Library
  declaration checking is skipped because Drizzle publishes declarations for
  optional cross-dialect integrations that do not pass this project's TypeScript
  version; application source remains fully checked. Neither TypeScript 7.0.2
  nor Drizzle ORM 1.0.0-rc.4 resolves these declaration errors, so re-enable
  library checking only after verifying an upstream Drizzle fix.
- `eslint.config.ts` uses ESLint flat config with type-aware strict and
  stylistic `typescript-eslint` presets; ESLint loads it through the `jiti`
  development dependency. It imports `.gitignore`, bans non-const type
  assertions, and enforces exhaustive switches and canonical named imports.
  Value and type bindings from one module share one declaration, with inline
  `type` markers. Default imports (except the default-only `@eslint/js`), import
  aliases, namespaces, side-effect imports, dynamic imports, import attributes,
  import-equals declarations, and `import()` types are rejected. Application
  source also rejects unsafe DOM HTML injection properties,
  `dangerouslySetInnerHTML`, and direct HTML-like string or template bodies in
  `Response`; TSX, tests, and fixtures are allowed.
- `knip.config.ts` checks every issue type and entry exports;
  `knip.production.config.ts` limits the production graph to runtime source.
  `bun run knip` runs both production and comprehensive test/tooling passes, so
  tests cannot keep production code alive while unused test helpers still fail.
- `.jscpd.json` maps all supported JavaScript and TypeScript extensions to the
  TSX format for cross-extension detection; import declarations are ignored,
  while other clones of at least 20 tokens and one line fail the zero-percent
  threshold.
- `scripts/repository-check.ts` lists existing tracked and unignored files and
  calls the focused policy APIs under `scripts/`. It rejects files reaching
  20,000 Unicode code points (excluding `bun.lock` and the generated `drizzle/`
  migration tree), JavaScript/TypeScript test files outside a directory named
  `test`, and `.htm`/`.html`/`.xhtml` application files outside directories
  named `test` or `fixtures`.
- Prettier wraps Markdown prose at its print width and uses
  `prettier-plugin-organize-imports` to sort, combine, and remove unused
  imports; generated/dependency output ignores come from `.gitignore`, while
  `bun.lock` is ignored separately. Drizzle migrations and metadata are included
  in formatting, which is enforced by `bun run check`.

## Decisions and Gotchas

- The package is marked private and uses ESM (`"type": "module"`).
- Google login reads `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and the
  optional `GOOGLE_REDIRECT_URI`; both credentials must be present together. The
  default local callback is `http://localhost:3000/api/auth/google/callback`,
  which must be registered exactly on the Google web OAuth client. Never expose
  the client secret to browser code or tracked files.
- `DATABASE_PATH` selects the local SQLite file and defaults to
  `data/q-mush.sqlite`; the default `data/` directory is ignored. Change
  `src/database/schema.ts`, add every new table to `databaseSchema` in
  `src/database.ts`, run `bun run db:generate`, and commit the resulting
  migration and Drizzle metadata. `bun run db:migrate` applies migrations
  without starting the HTTP server. Drizzle Kit loads its config under Node, so
  shared config imports must not transitively import `bun:sqlite`.
- Credential storage needs stable, private, 32-byte base64url secrets:
  `OPENAI_CREDENTIAL_KEY`, `OPENROUTER_CREDENTIAL_KEY`, and
  `BRAVE_SEARCH_CREDENTIAL_KEY`. Provider redirect URIs must end in the matching
  `/api/<provider>/oauth/callback` path. OpenAI uses the Codex public OAuth
  client ID by default and starts a localhost-only callback server on its
  registered `http://localhost:1455/auth/callback`; keep that port free.
  `OPENAI_CLIENT_ID` overrides the client and disables the default loopback when
  it differs, so that client must allow the configured or request-origin
  callback. OpenRouter's OAuth authorization needs no client credentials and
  exchanges a code for a user-controlled key. Removing any provider credential
  soft-deletes its audit record and clears its encrypted payload, but cannot
  revoke provider-side access.
- `src/ids.ts` is the authoritative UUIDv7 generator and defines `SYSTEM` as the
  system audit actor. User actions use the internal user UUID. Never issue hard
  deletes for application records: set `isDeleted`, `updatedAt`, and
  `updatedById`, and exclude soft-deleted rows from active queries. Audit actor
  fields deliberately are not foreign keys because `SYSTEM` is not a user row.
- Keep HTTP `deflate` zlib-wrapped; Bun's implementation is raw.
- Knip rule severities alone do not activate default-off issue types; keep its
  authoritative included-issue list complete so it can generate every error
  rule. Do not run the full test suite in parallel with lint or other repository
  scans: tooling-policy tests briefly create intentionally invalid probe files
  under `src`.
- A runner install command uses the HTTP request origin. To connect another
  computer, access the control center through an origin reachable from that
  computer rather than `localhost`. Removing a runner revokes its server-side
  registration but does not remove `~/.q-mush/runner` from the computer. Legacy
  `q-mush-runner.js` installations need the installer rerun once before they can
  auto-update.
- Bun 1.3.14's `Bun.build({ compile: ... })` writes the actual standalone binary
  only to `compile.outfile`; `outputs[0]` is still the bundled JavaScript. Keep
  runner builds in a temporary directory and read the outfile before cleanup.
  Cross-target compilation may first download the matching Bun executable into
  Bun's user cache, while subsequent runner downloads use the in-process binary
  cache.
- Agent file tools are confined to the selected runner workspace, including
  symlink resolution, but `bash` intentionally has the runner account's full
  shell permissions and is only rooted at that directory. The authenticated
  directory picker intentionally browses outside a session workspace with the
  selected runner account's filesystem permissions; it returns directory
  metadata only, bounds each listing, and times out stalled requests. Stopping a
  session aborts its model request and pushes runner-command cancellation over
  WebSocket so an active shell command terminates. OpenAI API-key and OAuth
  requests prefer Responses WebSocket mode and fall back to HTTP streaming;
  OpenRouter uses its supported streaming chat-completions transport. OpenAI
  OAuth refreshes its encrypted token bundle shortly before expiry. Provider
  defaults are `gpt-4.1-mini`, `openai/gpt-4.1-mini`, and `gpt-5-codex` for
  OpenAI keys, OpenRouter, and OpenAI OAuth respectively; they are API fallbacks
  and catalog metadata, not browser selection defaults or catalog sources.
  Browser catalogs come from OpenAI `/v1/models`, OpenRouter
  `/api/v1/models/user`, or the ChatGPT Codex `/models` endpoint. Codex response
  parsing retains streamed output-text and function-call argument deltas because
  a completed event may omit its `output` items. OpenAI's standard model list
  has no reasoning capabilities, while OpenRouter and Codex return
  model-specific efforts. Session drafts use each model's maximum discovered
  effort. Optional reasoning uses `reasoning_effort` for OpenAI chat completions
  and `reasoning.effort` for OpenRouter and Codex Responses. OpenAI Responses
  WebSockets omit HTTP stream fields and fall back to HTTP only before any
  provider event, avoiding replay after partial output. Agent model calls retry
  network failures and retryable HTTP responses three times with abortable
  backoff, honoring `Retry-After`.
- Agent launches and brokered runner commands have no application-owned turn,
  queue, or elapsed-time limits. Every shell command must choose a positive
  timeout; no default or configured maximum is supplied. Outside explicit or
  95%-threshold compaction, provider requests replay the full active
  conversation and have no application-level timeout.
- Add each new runtime source root and executable entry to
  `knip.production.config.ts`. Add standalone non-TypeScript build entries, such
  as `src/styles.css`, to both Knip configs; keep test files and test-support
  directories out of production project patterns.
- Put every test file under a directory named `test`; the directory may appear
  at any depth, such as `scripts/test` or `apps/control-center/test`.
