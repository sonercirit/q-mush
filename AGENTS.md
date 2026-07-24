# AGENTS.md

Living project memory; update durable information.

## Project Snapshot

- Private strict-TypeScript ESM Bun/SolidJS.
- Source: `solid/`, `sync-engine/`, `runner/`, `shared/`; server:
  `sync-engine/index.ts`.
- Tests live in `test/` directories; no `src/`.
- Homepage `/`; app `/app`.
- Tests use Vitest with Bun.

## Working Agreements

- Inspect repository before edits.
- Preserve patterns; add dependencies only when needed.
- Practice TDD: update a failing test, then implement and refactor green.
- Follow DRY: keep facts and logic authoritative; avoid premature abstractions.
- Follow KISS: prefer the simplest clear solution that meets requirements.
- Follow local-first: keep core workflows local; remote services enhance them.
- Run focused checks after changes, then broader checks when practical.
- Keep changes focused; do not modify unrelated files.
- Never commit secrets, generated artifacts, or local env files.

## Setup and Commands

- Install: `bun install`; run: `bun run sync-engine/index.ts`
- Develop: `bun run dev`; restart: `bun run dev:restart`; build: `bun run build`
- Generate/apply database migrations: `bun run db:generate` /
  `bun run db:migrate`
- Run tests: `bun run test`; watch: `bun run test:watch`
- Check repository constraints: `bun run repository-check`
- Check formatting: `bun run format:check`
- Format files: `bun run format`
- Type-check: `bun run typecheck`
- Check dead code/dependencies: `bun run knip`; duplicates: `bun run cpd`
- Lint/fix: `bun run lint` / `bun run lint:fix`; all static checks:
  `bun run check`
- CI runs tests/static checks on push via `.github/workflows/checks.yml` with
  Bun 1.3.14 and a frozen lockfile.

## Architecture and Conventions

- Bun manages dependencies via committed `package.json` and `bun.lock`.
- Production source has four enforced top-level workspaces. `solid` owns browser
  UI, `sync-engine` the Bun server and integrations, `runner` the standalone
  runner, and `shared` cross-workspace code. The first three may import only
  themselves and `shared`; `shared` cannot import another workspace. Code
  outside `scripts` cannot import from `scripts`.
- `sync-engine/server.ts` serves the browser JavaScript and Tailwind CSS built
  in memory by Vite. Browser state, session updates, and runner work use
  authenticated WebSockets at `/api/realtime` and `/api/runner/realtime`; there
  is no polling or SSE application transport. Because agents may modify this
  repository through the running app, `bun run dev` does not restart for source
  edits. `scripts/dev.ts` watches only the ignored
  `data/development-server.restart` trigger written by `bun run dev:restart`.
  `sync-engine/runner-executable.ts` fingerprints the runner source and
  compiler, builds in a private temporary directory, caches it in memory, and
  serves it from `/runner/executable`. Triggered development restarts reject new
  agent work, let active sessions finish, then replace the server process, so a
  session can safely request its own restart. Textual response bodies are
  precompressed once per handler, with `zstd`, Brotli, gzip, or deflate
  negotiated in that server-preference order.
- `solid/pages.tsx` renders both server page shells through Solid's SSR runtime;
  `sync-engine/pages.ts` loads it with Vite's SSR runner for Bun. The browser
  app mounts from `solid/client.tsx`; routes live in `shared/routes.ts`.
- `sync-engine/auth.ts` implements Google OpenID Connect with an
  authorization-code + PKCE flow. It uses HttpOnly state/verifier cookies,
  fetches the basic profile, and discards provider tokens.
  `sync-engine/auth-store.ts` uses Drizzle with Bun SQLite to upsert users and
  persist seven-day sessions in the tables defined by
  `shared/database/schema.ts`. Application primary keys are UUIDv7 values;
  Google subjects and session cookie tokens are separate unique fields. Every
  application table has creation/update timestamps, actor IDs, and an
  `isDeleted` soft-delete flag. `shared/database.ts` applies committed
  `drizzle/` migrations when opening a connection. `sync-engine/index.ts`
  injects the persistent connection; the auth factory falls back to isolated
  in-memory SQLite when a connection is not supplied. Shared PKCE, provider
  parsing, and redirect logic lives in `sync-engine/oauth.ts`, while shared
  cookie and response helpers live in `sync-engine/http.ts`. `solid/client.tsx`
  reads `/api/auth/session`, gates the control center, and posts logout to
  `/api/auth/logout`. All API routes derive from the `/api` base path in
  `shared/routes.ts`.
- `sync-engine/runner-store.ts` persists any number of user runner
  registrations, with `runners`, with one active registration per machine
  fingerprint and one default runner per user. New sessions use the default
  online runner or the first one. `sync-engine/runners.ts` issues hashed opaque
  setup tokens, owns authenticated management and token-authenticated callback
  APIs, and derives installer commands from the request origin.
  `sync-engine/runner-installer.ts` emits the macOS/Linux one-line installer; it
  selects an x64/ARM64 and glibc/musl target, downloads one standalone
  executable, and starts it under `~/.q-mush/runner` by default without
  requiring Bun on that computer. The runner reports metadata and 15-second
  heartbeats on its authenticated WebSocket and checks for updates at startup
  and every five minutes. Its handshake version triggers update checks after
  server restarts; reconnecting replaces an older socket for the same runner.
  Updates use a source/compiler ETag and SHA-256 digest, atomically replace the
  executable, and restart it. Development restarts drain active sessions first.
  The browser panel/controller online presence. Reinstalling for the same user
  and machine rotates the existing registration to the new token instead of
  creating a second runner; another user's registration remains protected.
  Runner tokens never appear in list responses.
- Browser messages sort by time then ID. Live output anchors after the
  initiating message; snapshots replace it in place.
- `sync-engine/sessions.ts` and `sync-engine/session-store.ts` persist coding
  sessions. User messages support selecting or pasting up to eight 10 MB PNG,
  JPEG, GIF, or WebP images, persisted with the transcript and sent as native
  multimodal input. Sessions record cumulative active time, model cost
  (including compaction), token usage, and the context limit. OpenRouter charges
  are authoritative; others use captured/OpenAI estimates, with unknown prices
  unavailable. OAuth figures are API equivalents, not subscription charges.
  Usage is yellow at 80% and red at 90%. Auto-compaction defaults on and
  summarizes completed history before the next request at 95%; idle sessions can
  compact manually. The existing-session composer stays mounted across status
  changes and explains why actions are unavailable. Versioned browser-local
  preferences filter transcript categories without changing message data.
  Compaction soft-deletes prior active messages and inserts a replayable
  handoff. Provider secrets never enter browser or runner work payloads. The
  working-directory field opens the interactive browser in
  `solid/directory-picker-client.tsx`; its controller posts to
  `/api/runners/:id/directories` for canonical directory metadata. Before each
  run, `read_agent_file` loads exact-root `AGENTS.md`, falling back to
  `CLAUDE.md`; only `AGENTS.md` is used when both exist.

  `runner/runner-workspace.ts` shares canonical workspace resolution and
  containment with the file tools. Tool and skill selections persist per
  session. Grouped session tools spawn non-blocking child sessions, manage owned
  sessions, report each child's final message to its parent, and resume an idle
  parent when its report arrives. `parallel` accepts 2+ tools or skills, has no
  count cap, and uses four ordered workers with bounded output. `page_fetch`
  renders a Chromium page. Picker details come from canonical schemas.
  `solid/session-transcript.tsx` renders prompts, tool definitions, Markdown,
  code/JSON, diffs, and results. The session list paginates ten at a time. The
  control center manages live sessions through `solid/realtime-client.ts`,
  `solid/session-client.tsx`, and `solid/session-controller.ts`. Model deltas
  are combined per session once per animation frame; snapshots and other events
  remain immediate. Unchanged snapshots suppress notifications, and keyed
  messages preserve identity so only the affected message rerenders. The
  long-lived Solid root preserves focus and scroll. The transcript starts and
  returns to the bottom when messages or the agent file change.
  `sync-engine/agent-model-discovery.ts` queries provider model metadata;
  `shared/agent-configuration.ts` owns catalog types and fallbacks. New sessions
  default to the online runner and model credential, then the first entry. The
  working directory uses the latest session; models use the first option and
  maximum reasoning effort. Model choices show all provider and Q Mush-supported
  input/output modalities. `solid/custom-select.tsx` searches then paginates
  lists over ten items, ten per page. It opens on the selected page,
  resets/clamps pages, and owns accessible keyboard/focus.
  `shared/agent-prompt.ts` builds the model system prompt and its transcript
  display. Reasoning summaries persist as `thinking` messages but are excluded
  from replay. Session and transcript rows live in `agent_sessions` and
  `agent_messages`; interrupted processes mark active sessions failed so they
  can be resumed. Rebuilt conversations add error results for interrupted tool
  calls only on resume.

- `sync-engine/openai.ts` and `sync-engine/openrouter.ts` implement provider
  connections. Multiple OAuth or manual credentials live in
  `provider_credentials`, encrypted with per-record AES-256-GCM context; API
  responses expose only metadata. One OpenAI or OpenRouter credential may be the
  user's model default across both providers. Shared behavior is in
  `sync-engine/provider-credentials.ts`,
  `sync-engine/connected-account-oauth.ts`, `solid/provider-client.tsx`, and
  `solid/provider-controller.ts`.
- `sync-engine/brave-search.ts` implements the authenticated server-side
  `brave_search` skill and key API. Users can keep multiple encrypted keys in
  `provider_credentials`; failures fall through keys in creation order, and
  secrets never reach the browser, runner, or model provider. Its UI reuses the
  shared credential panel and controller.
- The UI uses SolidJS and Vite. `solid/client.tsx` is the browser entry,
  `solid/pages.tsx` owns server-rendered shells, and `solid/styles.css` is
  Tailwind's source. Vitest uses an SSR Solid transform for string-rendering
  tests and a Happy DOM project for post-mount reactivity tests. Run it under
  Bun because tests and application modules use Bun APIs and `bun:sqlite`.
- TypeScript is configured for strict, no-emit, bundler-style checking in
  `tsconfig.json`, including unused and unreachable code diagnostics. Library
  declaration checking is skipped because Drizzle publishes declarations for
  optional cross-dialect integrations that do not pass this project's TypeScript
  version; application source remains fully checked. Neither TypeScript 7.0.2
  nor Drizzle ORM 1.0.0-rc.4 resolves these declaration errors, so re-enable
  library checking only after verifying an upstream Drizzle fix.
- `eslint.config.ts` uses type-aware strict/stylistic `typescript-eslint`
  presets. It imports `.gitignore`, bans non-const assertions, and enforces
  exhaustive switches and canonical named imports. Bindings from one module
  share one declaration with inline `type` markers. Default imports are allowed
  only for `@eslint/js`, `@tailwindcss/vite`, and `vite-plugin-solid`; aliases,
  namespaces, dynamic imports, import attributes, import-equals declarations,
  and `import()` types are rejected, as are side-effect imports except
  `solid/styles.css`. Application source also rejects unsafe DOM HTML injection
  properties, `dangerouslySetInnerHTML`, and direct HTML-like string or template
  bodies in `Response`; TSX, tests, and fixtures are allowed.
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

- The package is private ESM (`"type": "module"`).
- Google login reads `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and the
  optional `GOOGLE_REDIRECT_URI`; both credentials must be present together. The
  default local callback is `http://localhost:3000/api/auth/google/callback`,
  which must be registered exactly on the Google web OAuth client. Never expose
  the client secret to browser code or tracked files.
- `DATABASE_PATH` selects SQLite (default `data/q-mush.sqlite`; `data/` is
  ignored). Update `shared/database/schema.ts` and register new tables in
  `databaseSchema`; run `bun run db:generate` and commit its migration and
  metadata. `bun run db:migrate` runs without HTTP. Drizzle Kit runs config
  under Node, so it must not transitively import `bun:sqlite`. Drizzle's
  migration transaction nullifies its foreign-key PRAGMAs; `createDatabase`
  disables foreign keys beforehand and reenables them afterward.
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
- `shared/ids.ts` is the authoritative UUIDv7 generator and defines `SYSTEM` as
  the system audit actor. User actions use the internal user UUID. Never issue
  hard deletes for application records: set `isDeleted`, `updatedAt`, and
  `updatedById`, and exclude soft-deleted rows from active queries. Audit actor
  fields deliberately are not foreign keys because `SYSTEM` is not a user row.
- Keep HTTP `deflate` zlib-wrapped; Bun's implementation is raw.
- Knip rule severities alone do not activate default-off issue types; keep its
  authoritative included-issue list complete so it can generate every error
  rule. Do not run the full test suite in parallel with lint or other repository
  scans: tooling-policy tests briefly create intentionally invalid probe files
  under `solid`.
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
  and `reasoning.effort` for OpenRouter and Codex Responses. Streamed reasoning
  deltas are grouped by `output_index` and `summary_index`; separate summary
  parts with paragraphs because completed responses may omit their output.
  OpenAI Responses WebSockets retry interruptions after deltas, which remain
  UI-only until persistence. Retries reset the browser stream; exhausted
  attempts use HTTP. Failures persist as non-replayed `error` messages.
- Shell commands require a positive timeout. On macOS/Linux each has a POSIX
  session; stop/timeout signals only its group, including descendants retaining
  pipes. Agent launches and runner commands otherwise have no application-owned
  turn, queue, or elapsed-time limits. Outside explicit or 95%-threshold
  compaction, providers replay the full conversation without a timeout.
- Add each new runtime source root and executable entry to
  `knip.production.config.ts`. Add standalone non-TypeScript build entries, such
  as `solid/styles.css`, to both Knip configs; keep test files and test-support
  directories out of production project patterns.
- Put every test file under a directory named `test`; the directory may appear
  at any depth, such as `scripts/test` or `apps/control-center/test`.
