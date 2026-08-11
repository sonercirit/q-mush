# AGENTS.md

Living project memory.

## Project Snapshot

- Private strict-TypeScript ESM Bun/SolidJS project; tests live under `test/`
  (no `src`). `/` is the homepage, `/app` the app.

## Working Agreements

- Always research online before a change, unasked: search current provider docs
  and issue trackers (brave-search skill) for each integration or surprise —
  search finds switches probes miss. Then verify: probe real APIs with local
  credentials, inspect local services (configs, logs), enumerate schemas via
  validation errors, read usage metrics.
- Call a capability impossible only when evidence excludes it — docs searched,
  schema enumerated, matrix covered — otherwise record an open question.
- Preserve patterns, keep changes focused, add tools only as needed.
- Practice TDD: failing test first, implement, refactor green.
- Follow DRY and KISS: keep logic authoritative without premature abstractions;
  prefer the simplest clear solution.
- Never invent numeric limits or tunables: probe omission first and prefer the
  provider's default; otherwise derive values from provider metadata, docs, or
  feedback.
- Integrate completely the first time: wire every session capability (reasoning,
  caching, attachments, limits) to each protocol's native control, recording
  what a protocol lacks.
- No reward hacking: never weaken tests, special-case checks, or claim
  unperformed verification; disclose whatever stays unverified. Fix obvious
  defects on sight, unprompted — and when an experiment proves the obvious fix
  harmful, codify why in a test.
- Record new decisions, gotchas, and lessons here in the same change, unprompted
  — a repeated user instruction means a rule is missing, so add it; condense
  elsewhere to fit the size policy. When evidence overturns a recorded finding,
  fix the code it justified and every stale record — here, code comments,
  handoff, PR text — in that change; act, don't ask.
- Keep workflows local-first. Time is money: narrow checks per change, broad
  suites once with output captured, then rerun only the narrowest failing scope.
- Never commit secrets, generated artifacts, or env files.

## Setup and Commands

- Install/run: `bun install`; `bun run sync-engine/index.ts`
- Develop: `bun run dev` (+ `dev:restart`); build: `bun run build`
- Migrations: `bun run db:generate` / `db:migrate`
- Test/watch: `bun run test` / `test:watch`
- `bun run check` runs all static checks (`format:check`, `typecheck`, `lint`,
  `knip`, `cpd`, `repository-check`), each also standalone; `bun run format` /
  `lint:fix` write fixes.
- CI (`.github/workflows/checks.yml`): tests, static checks, build, and
  whitespace checks on Bun 1.3.14 with a frozen lockfile.

## Architecture and Conventions

- Production source has four enforced top-level workspaces: `solid` owns browser
  UI, `sync-engine` the Bun server and integrations, `runner` the standalone
  runner, and `shared` cross-workspace code. The first three import only
  themselves and `shared`; `shared` imports no other workspace, and code outside
  `scripts` cannot import `scripts`.
- `sync-engine/server.ts` serves the browser JavaScript and Tailwind CSS that
  Vite builds in memory. Browser state, session updates, and runner work use
  authenticated WebSockets at `/api/realtime` and `/api/runner/realtime`; no
  polling or SSE. Because agents may modify this repository via the running app,
  `bun run dev` watches production source and local `.env` files, coalesces
  bursts, and requests the same ignored `data/development-server.restart`
  trigger as `bun run dev:restart`. `sync-engine/runner-executable.ts`
  fingerprints the runner source and compiler, builds in a private temp
  directory, caches in memory, and serves `/runner/executable`. Development
  restarts queue new agent work, let active steps finish, then replace the
  server process, so a session can safely request its own restart. Textual
  bodies precompress once per handler, negotiating `zstd`, Brotli, gzip, then
  deflate. `/favicon.svg` revalidates with ETag, separate from PWA icons.
- `solid/pages.tsx` renders both server page shells through Solid's SSR runtime;
  `sync-engine/pages.ts` loads it with Vite's SSR runner for Bun. The browser
  app mounts from `solid/client.tsx`; routes live in `shared/routes.ts`.
- `sync-engine/auth.ts` implements Google OpenID Connect (authorization code +
  PKCE) with HttpOnly state/verifier cookies, fetching the basic profile and
  discarding provider tokens. `sync-engine/auth-store.ts` uses Drizzle with Bun
  SQLite to upsert users and persist seven-day sessions in the schema tables.
  Application primary keys are UUIDv7; Google subjects and session cookie tokens
  are separate unique fields; every table carries creation/update timestamps,
  actor IDs, and an `isDeleted` flag. `shared/database.ts` applies committed
  `drizzle/` migrations on open; `sync-engine/index.ts` injects the persistent
  connection, and the auth factory falls back to in-memory SQLite. Shared PKCE,
  provider parsing, and redirects live in `oauth.ts`; cookie and response
  helpers in `http.ts`. `solid/client.tsx` reads `/api/auth/session`, gates the
  control center, and posts logout.
- `sync-engine/runner-store.ts` persists user runner registrations in `runners`:
  one active registration per machine fingerprint, one default runner per user.
  `sync-engine/runners.ts` issues hashed opaque setup tokens, owns authenticated
  management and token-authenticated callback APIs, and derives installer
  commands from the request origin. `sync-engine/runner-installer.ts` emits the
  macOS/Linux one-liner: it picks an x64/ARM64 glibc/musl target and starts a
  downloaded standalone executable under `~/.q-mush/runner`; no Bun needed. The
  runner reports metadata and 15-second heartbeats over its authenticated
  WebSocket, checks for updates at startup and every five minutes, rechecks via
  handshake version after restarts, and replaces an older socket on reconnect.
  Updates use a source/compiler ETag and SHA-256 digest, atomically replace the
  executable, and restart it; development restarts drain active sessions first.
  Reinstalling for the same user and machine rotates the registration to the new
  token instead of adding a second runner; other users' registrations stay
  protected, and tokens never appear in list responses.
- Browser messages sort by time then ID; live output anchors after its
  initiating message, snapshots replacing it. `session-agent-read.ts`
  byte-bounds transcript messages, assistant calls, the system prompt, and tool
  definitions.
- `sync-engine/sessions.ts` and `session-store.ts` persist coding sessions. User
  messages support eight 10 MB PNG/JPEG/GIF/WebP images, persisted as native
  multimodal input. Sessions record cumulative active time, model cost including
  compaction, token usage, and the context limit; reported charges are
  authoritative; estimates need provider-discovered rates per token category.
  Auto-compaction defaults on: at 95% it summarizes completed history and
  continues from the handoff; idle sessions compact manually, and compaction
  soft-deletes prior messages while inserting a replayable handoff. The composer
  stays mounted across statuses, explaining unavailable actions and preserving
  drafts; local preferences filter transcript categories. Provider secrets stay
  out of browser and runner work payloads. The working-directory field opens
  `solid/directory-picker-client.tsx` backed by `/api/runners/:id/directories`.
  Each run, `read_agent_file` loads exact-root `AGENTS.md` (else `CLAUDE.md`).

  `runner/runner-workspace.ts` shares canonical workspace resolution and
  containment with file tools. Tool and skill choices persist per session;
  picker details use canonical schemas. Bounded `read_session` spans transcript
  categories and definitions; `get_session_options` pages spawn choices. Grouped
  tools manage non-blocking owned children, report final messages, and resume
  idle parents; `parallel` takes 2+ calls on four ordered workers, bounds
  output, propagates cancellation. `solid/session-transcript.tsx` renders
  prompts, tool definitions, raw details, Markdown, code/JSON, diffs, and
  contextual results, preserving user line breaks; session lists paginate by
  ten. Live sessions use `solid/realtime-client.ts`, `solid/session-client.tsx`,
  and `solid/session-controller.ts`: model deltas combine once per frame per
  session, other events stay immediate, unchanged snapshots suppress
  notifications, and keyed messages rerender only what changed. The long-lived
  Solid root preserves focus and scroll; the transcript starts at and returns to
  the bottom when messages or the agent file change. `agent-model-discovery.ts`
  queries metadata; `shared/agent-configuration.ts` owns catalog
  types/validation. New sessions use the default online runner (else the first
  one) and credential, first discovered model, latest working directory, and
  maximum reported reasoning effort. Unknown modalities do not imply attachment
  support; choices show provider and Q Mush modalities.
  `solid/custom-select.tsx` shares search normalization, paginates past ten
  items, and owns accessible keyboard/focus. Focus mode fills the app viewport
  (not browser Fullscreen), preserving drafts and scroll; its rail overlays on
  desktop, becomes a small-screen drawer, collapses on selection, and closes
  with Escape first. Model and effort choices persist with the session.
  `shared/agent-prompt.ts` builds the model system prompt and transcript
  display; reasoning summaries persist as `thinking` messages excluded from
  replay. Session and transcript rows live in `agent_sessions` and
  `agent_messages`; interrupted processes mark active sessions failed for
  resumption, and rebuilt conversations add error results for interrupted tool
  calls only on resume.

- `openai.ts`, `openrouter.ts`, and `generic-provider.ts` implement model
  connections. Generic providers store a normalized base URL, an optional key,
  and an `apiFormat` toggle: the default OpenAI format uses `/models` plus
  streamed `/chat/completions`; the Anthropic format sends `x-api-key` and
  `anthropic-version` to `/models` and streamed `/messages`
  (`anthropic-request.ts`, `provider-stream-anthropic.ts`). Credentials live in
  `provider_credentials` with per-record AES-256-GCM encryption; API responses
  expose only metadata, and one credential may be the user's default across the
  three model providers. Shared behavior: `provider-credentials.ts`,
  `connected-account-oauth.ts`, and the `solid/provider-*` client modules.
- Measure cache hits against the cacheable prefix (total input dilutes with
  fresh tool output); persistent shortfalls are bugs, lone misses provider noise
  — writes land seconds late and 128-token blocks hide small growth. Codex
  socket reuse re-tested cache-neutral vs per-step reconnects (~92% at hit,
  sporadic misses in both; 0%-on-reuse did not reproduce), so sockets stay open
  across a run, reconnect on failure, and close at its end. UI rates divide by
  summed input minus the final request (summary) or the prior step's input (per
  step), clamped at 100%. Requests carry the session ID as `prompt_cache_key`
  and as the Codex `session_id` header (cache routing); that surface rejects
  `prompt_cache_breakpoint`/`prompt_cache_retention`. OpenRouter and generic
  requests mark one-hour `cache_control` breakpoints on the system prompt,
  transcript tail, and Anthropic tool definitions (`provider-prompt-cache.ts`);
  OpenAI rejects markers, so its caching stays automatic. Messages requests send
  no `max_tokens`; provider defaults govern.
- `sync-engine/brave-search.ts` implements the authenticated server-side
  `brave_search` skill and key API. Users keep multiple encrypted keys in
  `provider_credentials`; failures fall through keys in creation order, and
  secrets never reach browser, runner, or model provider. The UI reuses the
  shared credential panel and controller.
- The UI uses SolidJS and Vite. `solid/client.tsx` is the browser entry,
  `solid/pages.tsx` owns server-rendered shells, and `solid/styles.css` is
  Tailwind's source. Vitest uses an SSR Solid transform for string-rendering
  tests and a Happy DOM project for post-mount reactivity tests; run it under
  Bun because tests and application modules use Bun APIs and `bun:sqlite`.
- `tsconfig.json` configures strict, no-emit, bundler-style checking with unused
  and unreachable code diagnostics. Library declaration checking is skipped
  because Drizzle (ORM 1.0.0-rc.4, TypeScript 7.0.2) publishes optional
  cross-dialect declarations that fail here; application source stays fully
  checked. Re-enable it only after verifying an upstream Drizzle fix.
- `eslint.config.ts` uses type-aware strict/stylistic `typescript-eslint`
  presets, imports `.gitignore`, bans non-const assertions, and enforces
  exhaustive switches and canonical named imports (one declaration per module
  with inline `type` markers). Default imports: only `@eslint/js`,
  `@tailwindcss/vite`, `vite-plugin-solid`; aliases, namespaces, dynamic
  imports, import attributes, import-equals, `import()` types, and side-effect
  imports (except `solid/styles.css`) are rejected. First-party code rejects
  unsafe DOM HTML injection, `dangerouslySetInnerHTML`, and HTML-like `Response`
  bodies; HTML-like data and TSX pass.
- `knip.config.ts` checks every issue type and entry exports;
  `knip.production.config.ts` limits the graph to runtime source. Both passes
  run, so tests cannot keep production code alive and unused test helpers still
  fail.
- `.jscpd.json` maps all JS/TS extensions to the TSX format for cross-extension
  detection; import declarations are ignored, and clones of ≥20 tokens and one
  line fail the zero threshold.
- `scripts/repository-check.ts` lists tracked, unignored files and calls the
  policy APIs under `scripts/`: no files at 20,000 Unicode code points
  (`bun.lock` and `drizzle/` excepted), no JS/TS tests outside `test`
  directories, no `.htm(l)`/`.xhtml` app files outside `test`/`fixtures`.

## Decisions and Gotchas

- The HTTP server uses port 12345; `PORT` overrides.
- Google login reads `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and optional
  `GOOGLE_REDIRECT_URI`; the two must appear together. The callback
  `http://localhost:12345/api/auth/google/callback` must be registered exactly
  on the Google web OAuth client. Never expose the client secret to browser code
  or tracked files.
- `DATABASE_PATH` selects SQLite (default `data/q-mush.sqlite`; `data/` is
  ignored). Update `shared/database/schema.ts`, register tables in
  `databaseSchema`, `bun run db:generate`, and commit the migration and
  metadata; `bun run db:migrate` runs without HTTP. Drizzle Kit runs its config
  under Node; never transitively import `bun:sqlite` there. Drizzle's migration
  transaction nullifies its foreign-key PRAGMAs, so `createDatabase` disables
  foreign keys first, reenabling them afterward.
- Credential storage needs stable, private, 32-byte base64url `*_CREDENTIAL_KEY`
  secrets for OpenAI, OpenRouter, generic, and Brave Search; provider redirect
  URIs end in `/api/<provider>/oauth/callback`. OpenAI defaults to the Codex
  public OAuth client with a localhost-only callback on its registered
  `http://localhost:1455/auth/callback` (keep the port free); a differing
  `OPENAI_CLIENT_ID` disables that loopback and must allow the configured or
  request-origin callback. OpenRouter's OAuth needs no client credentials and
  yields a user-controlled key. Removing a credential soft-deletes its audit
  record and clears its payload but cannot revoke provider-side access.
- `shared/ids.ts` is the authoritative UUIDv7 generator and defines `SYSTEM` as
  the system audit actor; user actions use the internal user UUID. Never hard
  delete application records: set `isDeleted`, `updatedAt`, and `updatedById`,
  and exclude soft-deleted rows from active queries. Audit actor fields are
  deliberately not foreign keys because `SYSTEM` is not a user row.
- Keep HTTP `deflate` zlib-wrapped; Bun's is raw.
- Knip severities alone do not activate default-off issue types; keep the
  included-issue list complete. Do not run the full test suite in parallel with
  lint or repository scans; tooling-policy tests briefly create invalid probe
  files under `solid`.
- Runner install commands use the HTTP request origin: connect other computers
  through a reachable origin, not `localhost`. Removing a runner revokes its
  registration but leaves `~/.q-mush/runner`. Legacy `q-mush-runner.js` installs
  need one installer rerun to auto-update.
- Bun 1.3.14's `Bun.build({ compile: ... })` writes the standalone binary only
  to `compile.outfile` (`outputs[0]` is bundled JavaScript): build runners in a
  temporary directory and read the outfile before cleanup. Cross-target
  compilation may download a Bun into the user cache.
- File tools stay in the runner workspace after symlink resolution; only
  session-owned non-read output spills may leave it, and `read` pages its
  source. `bash` has full runner-account permissions, rooted there. The
  directory picker browses beyond a session workspace with runner-account
  permissions, returns only directory metadata, bounds listings, and times out
  stalls. Stopping a session aborts its model request and pushes runner-command
  cancellation, terminating an active shell command. OpenAI API-key and OAuth
  requests prefer Responses WebSockets, falling back to HTTP streaming;
  OpenRouter and generic endpoints stream chat completions, Anthropic-format
  endpoints Messages events. OpenAI OAuth refreshes its token bundle shortly
  before expiry. Session creation requires an explicit model ID with no built-in
  fallbacks. Catalogs: OpenAI `/v1/models`, OpenRouter `/api/v1/models/user`,
  ChatGPT Codex `/models`, or the generic `/models`; Anthropic-format catalogs
  read `display_name` and `max_input_tokens`, and merge per-model
  `supported_reasoning_efforts` from the endpoint's OpenAI-style listing when
  served. Codex parsing retains streamed output-text and function-call argument
  deltas since completed events may omit `output`. Only explicitly listed
  efforts are offered; OpenAI's catalog lacks reasoning metadata. Optional
  reasoning uses `reasoning_effort` for OpenAI and generic chat completions and
  `reasoning.effort` for OpenRouter and Codex Responses; the Anthropic Messages
  format maps efforts to `output_config.effort` plus
  `thinking: {type: "adaptive", display: "summarized"}` on provider-default
  budgets, sending neither for `none`. Adaptive-only models (Fable) ignore
  `enabled`; newer models default `display` to `omitted` — empty thinking text
  plus a signature while thinking tokens bill. The local proxy tolerates
  tool-loop replay without signed thinking blocks; strict endpoints may not.
  Streamed reasoning deltas group by `output_index` and `summary_index`;
  separate summary parts with paragraphs because completed responses may omit
  them. OpenAI Responses WebSockets and accepted HTTP streams retry transient
  interruptions or provider errors only before a model step persists; partial UI
  deltas reset on replay, and exhausted WebSockets fall back to HTTP. Permanent
  provider errors and aborts do not retry; terminal failures persist as
  non-replayed `error` messages.
- Shell commands require a positive timeout; on macOS/Linux each gets a POSIX
  session, and stop/timeout signals only its group (descendants retaining pipes
  included). Agent launches and runner commands otherwise have no
  application-owned step, queue, or time limits; outside compaction, providers
  replay the whole conversation without a timeout.
- Add new runtime roots and standalone non-TypeScript build entries (like
  `solid/styles.css`) to the matching Knip configs; exclude test support from
  production patterns.
