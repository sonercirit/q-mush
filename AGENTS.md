# AGENTS.md

Living project memory.

## Project Snapshot

- Strict-TypeScript ESM Bun/SolidJS project; tests live under `test/`, no `src`.
  `/` is the homepage, `/app` the app.

## Working Agreements

- Research provider docs/trackers online, then probe APIs, schemas and metrics.
- Call capabilities impossible only with excluding evidence; else record a
  question.
- Preserve patterns; improve touched code, tests, docs, performance, security
  and DX.
- TDD: fail first, implement, refactor green. DRY/KISS: authoritative logic; no
  premature abstraction.
- Never invent tunables: probe omission, prefer provider defaults, else use
  metadata/docs.
- Integrate every capability with each protocol's native control; record gaps.
- Never weaken tests, special-case checks, or claim unperformed verification;
  disclose gaps. Fix defects on sight; if harmful, codify why in a test.
- Record decisions, gotchas and lessons here; repeated instructions mean a rule
  is missing. When evidence overturns a finding, fix its code and stale records;
  act, don't ask.
- Work local-first: narrow checks, then broad suites; rerun failing scope.
- Never commit secrets, generated artifacts, or env files.

## Setup, Commands

- Install/run: `bun install`; `bun run sync-engine/index.ts`
- Develop: `bun run dev` (+ `dev:restart`, `dev:watch`); `bun run build`
- Migrations: `bun run db:generate` / `db:migrate`
- Test: `bun run test` (DOM/server plus Chromium) / `test:watch`; use
  `bun run test:browser` for Chromium alone.
- `bun run check` runs every static check, each standalone too; `bun run format`
  / `lint:fix` write fixes.
- CI (`.github/workflows/checks.yml`): tests, static checks, build, and
  whitespace checks on Bun 1.3.14 with a frozen lockfile.

## Architecture and Conventions

- Four enforced production workspaces: `solid` owns browser UI, `sync-engine`
  the Bun server/integrations, `runner` the standalone runner, `shared`
  cross-workspace code. The first three import only themselves and `shared`;
  `shared` imports no other workspace; only `scripts` may import `scripts`.
- `server.ts` serves Vite's in-memory browser JS/Tailwind. Authenticated
  WebSockets at `/api/realtime` and `/api/runner/realtime` carry browser state,
  sessions, and runner work; no polling/SSE. `dev:watch` watches production
  source and local `.env`, coalescing bursts into the ignored restart trigger;
  `dev:restart` writes it and plain `dev` only reacts to it.
  `runner-executable.ts` fingerprints runner source/compiler, privately builds,
  caches in memory, and serves `/runner/executable`. Restarts drain active steps
  and queue new work, so sessions may request one. Text handlers precompress,
  negotiating zstd, Brotli, gzip, or deflate; `/favicon.svg` separately
  revalidates by ETag.
- `solid/pages.tsx` renders both server page shells via Solid's SSR runtime;
  `sync-engine/pages.ts` loads it with Vite's SSR runner. The browser app mounts
  from `solid/client.tsx`; routes live in `shared/routes.ts`.
- `sync-engine/auth.ts` implements Google OpenID Connect authorization code +
  PKCE with HttpOnly state/verifier cookies; it fetches the basic profile and
  discards provider tokens. `auth-store.ts` uses Drizzle/Bun SQLite for users
  and seven-day sessions. UUIDv7 primary keys, Google subjects, and cookie
  tokens are distinct; every table has timestamps, actor IDs, and `isDeleted`.
  `shared/database.ts` applies committed migrations; `index.ts` injects the
  persistent DB while auth falls back on in-memory SQLite. `oauth.ts` shares
  PKCE/provider parsing/redirects; `http.ts` shares cookie/response helpers.
  `solid/client.tsx` reads `/api/auth/session`, gates the app, and posts logout.
  Browser regressions use real Chromium/Tailwind and production state/UI
  mutations, not synthetic layout or CSS-only assertions; CI rejects `.only` and
  zero tests.
- `runner-store.ts` persists registrations: one active row per machine
  fingerprint and one default per user. `runners.ts` issues hashed opaque setup
  tokens and owns authenticated management/token callback APIs; installer
  commands derive from request origin. `runner-installer.ts` emits a macOS/Linux
  one-liner selecting x64/ARM64 glibc/musl and starting a standalone executable
  under `~/.q-mush/runner`; Bun is unnecessary. Runners send metadata and
  15-second heartbeats by authenticated WebSocket, check updates at startup and
  every five minutes, recheck via handshake version after restarts, and replace
  older sockets on reconnect. Updates use a source/compiler ETag and SHA-256,
  replace atomically, and restart; development restarts first drain sessions.
  Reinstalling the same user's machine rotates its registration token; other
  registrations stay protected and lists never expose tokens.
- Browser messages sort by time then ID; live output anchors at its initiator,
  snapshots replace it. `session-agent-read.ts` byte-bounds transcript messages,
  assistant calls, the system prompt, tool definitions.
- `sync-engine/sessions.ts` and `session-store.ts` persist coding sessions. User
  messages take eight 10 MB PNG/JPEG/GIF/WebP images as multimodal input.
  Sessions record active time, cost, token usage, and context limit; reported
  charges win. Auto-compaction defaults on at 95%; truncation enters only its
  immediate compactor context, including persisted manual/idle compaction, so
  partial output stays unfinished without marking a retry. Idle sessions compact
  manually or, opted in, at 30 idle minutes; compaction soft-deletes messages
  into a replayable handoff; replays say deliver drafts, don't re-verify. The
  composer stays mounted across statuses, explaining unavailable actions,
  keeping drafts; draft fields echo a local signal debounced into the shared
  draft — submit paths flush first; local prefs filter transcript categories.
  Provider secrets never reach browser or runner work payloads. The directory
  field opens `solid/directory-picker-client.tsx`
  (`/api/runners/:id/directories`). Each run, `read_agent_file` loads exact-root
  `AGENTS.md` (else `CLAUDE.md`).

  `runner/runner-workspace.ts` owns canonical workspace/tool paths. Session
  tool, skill, model and effort choices persist; pickers use canonical schemas.
  Bounded `read_session` covers transcript categories/definitions;
  `get_session_options` pages spawn choices. Grouped tools own non-blocking
  children, report finals and resume idle parents; `parallel` takes 2+ calls on
  four ordered workers, bounds output and propagates cancellation.
  `session-transcript.tsx` renders prompts, definitions, details, Markdown,
  code/JSON, diffs and contextual results while preserving user line breaks;
  lists page by ten. Live clients frame-coalesce model deltas, dispatch other
  events, suppress unchanged snapshots and keyed-rerender only changed messages.
  The long-lived Solid root preserves focus/scroll; changing session detail is
  not a document scroll anchor, and only bottom-pinned transcripts follow
  output. Model discovery is cancelable; `shared/agent-configuration.ts`
  validates catalogs. New sessions choose the default online runner (else
  first), default credential, first model, latest directory and highest reported
  effort. Unknown modalities mean no attachments; choices show provider/Q Mush
  modalities. `custom-select.tsx` shares normalized search/pagination and
  accessible keyboard focus. Focus mode fills the app viewport (not browser
  Fullscreen); its desktop overlay becomes a drawer, collapses on selection and
  closes first on Escape, preserving drafts and scroll. `shared/agent-prompt.ts`
  builds system/display prompts; persisted reasoning summaries aren't replayed.
  `agent_sessions`/`agent_messages` hold sessions/transcripts; `step_started_at`
  drives the Step timer and clears with `activeStartedAt`. Interrupted active
  sessions fail for resumption; rebuilds add interrupted-tool errors.

- `openai.ts`, `openrouter.ts`, and `generic-provider.ts` implement model
  connections. Generic providers store a normalized base URL, optional key, and
  an `apiFormat` toggle: the default OpenAI format uses `/models` plus streamed
  `/chat/completions`; the Anthropic format sends `x-api-key` and
  `anthropic-version` to `/models` and streamed `/messages`
  (`anthropic-request.ts`, `provider-stream-anthropic.ts`; images/PDFs map to
  native blocks). Credentials live in `provider_credentials` with per-record
  AES-256-GCM encryption; API responses expose only metadata; one credential may
  be the user's default across providers. Shared behavior:
  `provider-credentials.ts`, `connected-account-oauth.ts`, the
  `solid/provider-*` client modules.
- Measure cache hits against the cacheable prefix (total input dilutes with
  fresh tool output); persistent shortfalls are bugs, lone misses noise — writes
  land late and 128-token blocks hide small growth. Codex sockets stay open per
  run (cache-neutral), reconnect on failure, close at run end. UI rates divide
  by summed input minus the final request (summary) or the prior step's input
  (per step), clamped at 100%, counting only fully reported steps. OpenAI/Codex
  requests carry the session ID as `prompt_cache_key` and the Codex `session_id`
  header (cache routing); that surface rejects
  `prompt_cache_breakpoint`/`prompt_cache_retention`. OpenRouter and
  Anthropic-format requests mark one-hour `cache_control` breakpoints on the
  system prompt, transcript tail, and Anthropic tool definitions
  (`provider-prompt-cache.ts`); OpenAI rejects markers, and generic
  OpenAI-format endpoints get neither markers nor `prompt_cache_key` (Ollama
  rejects array content; strict servers reject unknown fields). Messages
  requests send catalog `max_tokens` (`agent_sessions.max_output_tokens`),
  omitted when discovery reported none — the real API requires it, proxies
  don't; the context-window-exceeded beta degrades pre-4.5 overshoots to a stop
  reason. Length stops persist a non-replayed `error` truncation notice
  (`AgentModelStep.truncation`). Null limits refresh lazily
  (`session-current-model.ts`) only while the credential stays attached,
  propagating stops, not degrading; generic reassignment nulls limits to
  re-probe; otherwise they snapshot like context limits.
- `sync-engine/brave-search.ts` implements the authenticated server-side
  `brave_search` skill and key API. Users keep multiple encrypted keys in
  `provider_credentials`; failures fall through keys in creation order; secrets
  never reach browser, runner, or model provider.
- `solid/client.tsx` is the browser entry, `solid/pages.tsx` owns
  server-rendered shells, `solid/styles.css` is Tailwind's source. Vitest uses
  an SSR Solid transform for string rendering and a Happy DOM project for
  post-mount reactivity; run it under Bun — tests and app modules use Bun APIs
  and `bun:sqlite`. Fixtures stub provider discovery; tests never hit live
  provider APIs.
- `tsconfig.json` configures strict, no-emit, bundler-style checking with unused
  and unreachable code diagnostics. Library declaration checking is off —
  Drizzle publishes optional cross-dialect declarations that fail here; app
  source stays fully checked; re-enable after an upstream Drizzle fix.
- `eslint.config.ts` uses type-aware strict/stylistic `typescript-eslint`
  presets, imports `.gitignore`, bans non-const assertions, enforces exhaustive
  switches and canonical named imports (one declaration per module with inline
  `type` markers). Default imports: only `@eslint/js`, `@tailwindcss/vite`,
  `vite-plugin-solid`; aliases, namespaces, dynamic imports, import attributes,
  import-equals, `import()` types, and side-effect imports (except production
  and browser-test imports of `solid/styles.css`) are rejected. First-party code
  rejects unsafe DOM HTML injection, `dangerouslySetInnerHTML`, and HTML-like
  `Response` bodies; HTML-like data and TSX pass.
- Knip checks every issue type and entry export in test and production graphs;
  tests cannot keep production alive, and unused test helpers fail.
- CPD maps all JS/TS extensions to TSX and ignores imports. Its parse-error path
  deliberately matches native CPD's crude whole-file fallback tokenizer.
  Native-token and complete-function alpha matches of ≥20 tokens spanning a line
  boundary fail the zero threshold; alpha ignores locally bound names but
  preserves free names, member APIs, and literals.
- Repository policy scans tracked, unignored files: 20,000-code-point maximum
  (`bun.lock`, `drizzle/` excepted), tests only under `test`, no app HTML
  outside `test`/`fixtures`.

## Decisions and Gotchas

- HTTP port 12345 (`PORT` overrides).
- Google login reads `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and optional
  `GOOGLE_REDIRECT_URI`; the two appear together; register the callback
  `http://localhost:12345/api/auth/google/callback` on the OAuth client. Never
  expose the client secret to browser code.
- `DATABASE_PATH` selects SQLite (default `data/q-mush.sqlite`; `data/`
  ignored). Update `shared/database/schema.ts`, register tables in
  `databaseSchema`, `bun run db:generate`, commit the migration and metadata;
  `bun run db:migrate` runs without HTTP. Drizzle Kit runs its config under
  Node; never transitively import `bun:sqlite` there. Drizzle's migration
  transaction nullifies its foreign-key PRAGMAs, so `createDatabase` disables
  foreign keys first, reenabling after.
- Credential storage needs stable, private, 32-byte base64url `*_CREDENTIAL_KEY`
  secrets per provider; provider redirect URIs end in
  `/api/<provider>/oauth/callback`. OpenAI defaults to the Codex public OAuth
  client with a localhost-only callback on its registered
  `http://localhost:1455/auth/callback` (keep that port free); a differing
  `OPENAI_CLIENT_ID` disables that loopback and must allow the configured or
  request-origin callback. OpenRouter OAuth needs no client credentials,
  yielding a user-controlled key. Credential removal soft-deletes the audit
  record and clears the payload; provider-side access stays.
- `shared/ids.ts` owns UUIDv7 generation and defines the `SYSTEM` audit actor;
  user actions use the internal user UUID. Never hard-delete records: set
  `isDeleted`, `updatedAt`, and `updatedById`, excluding soft-deleted rows from
  active queries. Audit actor fields are not foreign keys — `SYSTEM` is not a
  user row.
- Keep HTTP `deflate` zlib-wrapped; Bun's is raw. page_fetch proxy upstream
  connects bound at 10s, subordinate to the tool deadline.
- Knip severities alone do not activate default-off issue types; keep the
  included-issue list complete. Do not run the full test suite parallel to lint
  or repository scans; tooling-policy tests probe `solid`.
- Runner install commands use the HTTP request origin: connect other machines
  through a reachable origin, not `localhost`. Removing a runner leaves
  `~/.q-mush/runner`.
- Bun 1.3.14's `Bun.build({ compile: ... })` writes the binary only to
  `compile.outfile` (`outputs[0]` is bundled JS): build in a temp directory and
  read the outfile before cleanup.
- Bare-metal file tools resolve relative paths against the runner workspace but
  accept any runner-account-accessible path; container file tools and attachment
  records stay contained (they run on the host). Container shells run as root in
  a disposable per-session Arch container (default `archlinux:latest`) with
  network and default capabilities, so pacman works; only the workspace mounts.
  `read` pages its source. The directory picker browses beyond a session
  workspace with runner-account permissions, returns bounded directory-only
  metadata, times out stalls. Stopping a session aborts its model request and
  cancels runner commands, ending an active shell. OpenAI API-key and OAuth
  requests prefer Responses WebSockets, falling back to HTTP streaming. An OAuth
  API 401 forces one refresh and one unpersisted-step replay, clearing partial
  output first; concurrent refreshes coalesce because refresh tokens rotate. A
  second 401 stops. Terminal refresh rejection persists re-login-required state,
  excludes balanced pools, and tells the session/UI to reconnect. Reconnect
  fails closed unless stored and returned account IDs match; OpenRouter accounts
  without `user_id` cannot reconnect until it returns one. API keys bypass this
  path. Responses WebSocket auth events lack reliable HTTP status, so recovery
  also recognizes canonical nested `authentication_error` and `invalid_api_key`
  signals; OpenAI documents the nested event shape and that
  `AuthenticationError` means an invalid, expired, or revoked token. Native
  attachments share the session refresher; distinct fallbacks bind their
  selected credential's refresher. OpenRouter and generic endpoints stream chat
  completions, Anthropic-format endpoints Messages events. OpenAI OAuth
  refreshes its token bundle before expiry. Session creation needs an explicit
  model ID. Catalogs: OpenAI `/v1/models`, OpenRouter `/api/v1/models/user`,
  ChatGPT Codex `/models`, or the generic `/models`; Anthropic-format catalogs
  read `display_name`, `max_input_tokens`, `max_tokens`, and the `capabilities`
  tree (`agent-model-discovery-anthropic.ts`: effort and adaptive-thinking
  support are independent; modalities come only from `image_input`/`pdf_input`
  leaves), page via `has_more`/`last_id` at `limit=1000` with stale-cursor and
  page-count guards, probing the endpoint's OpenAI-style listing only where
  capabilities left efforts unknown. Codex parsing retains streamed output-text
  and function-call argument deltas since completed events may omit `output`.
  Only listed efforts are offered; OpenAI's catalog lacks reasoning data.
  Optional reasoning uses `reasoning_effort` for OpenAI and generic chat
  completions and `reasoning.effort` for OpenRouter and Codex Responses; the
  Anthropic Messages format sends `output_config.effort`; unless persisted
  `adaptiveThinking` is false it adds
  `thinking: {type: "adaptive", display: "summarized"}`. Lazy model metadata
  refresh fills null fields independently and never replaces a known capability
  or output limit while learning the other. It sends neither for `none` and maps
  `minimal` to `low`. Adaptive-only models (Fable) ignore `enabled`; newer
  models default `display` to `omitted` — empty thinking text plus a signature
  while thinking tokens bill. The local proxy tolerates tool-loop replay without
  signed thinking blocks; strict endpoints may not. Streamed reasoning deltas
  group by `output_index` and `summary_index`; separate summary parts with
  paragraphs since completed responses may omit them. OpenAI's WebSocket Mode
  has a 60-minute limit; the canonical `websocket_connection_limit_reached` and
  observed underscore-free variant replace the socket once per step, then bound
  retries, replaying only an unpersisted step. Other WebSocket/accepted HTTP
  interruptions or provider errors retry before persistence; replays reset
  partial UI deltas and exhausted WebSockets fall back to HTTP. Permanent errors
  and aborts do not retry; terminal failures persist as non-replayed `error`
  messages.
- Shell commands require a positive timeout; on macOS/Linux each gets a POSIX
  session; stop/timeout signals only its group. Agent launches and runner
  commands otherwise have no application-owned step, queue, or time limits;
  outside compaction, providers replay the conversation without a timeout.
- Add new runtime roots and standalone build entries to the matching Knip
  configs; exclude test support from production patterns.
