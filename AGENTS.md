# AGENTS.md

Project memory.

## Project Snapshot

- Strict TypeScript ESM Bun/SolidJS; tests live under `test/`, no `src`. `/` is
  the homepage, `/app` the app.

## Working Agreements

- Call capabilities impossible only with excluding evidence; else record an open
  question.
- Preserve patterns and improve touched code.
- TDD: fail first, implement, refactor green. Keep authoritative logic simple;
  avoid premature abstraction.
- Research provider docs via Brave Search; probe APIs. For tunables, probe
  omission, prefer provider defaults, then metadata/docs.
- Fix defects on sight, even pre-existing; if harmful, codify why in a test.
- Integrate completely the first time: wire every session capability to each
  protocol's native control, recording what a protocol lacks.
- Never weaken checks or claim unperformed verification; disclose gaps.
- Record decisions and lessons here unprompted; repeated guidance means a rule
  is missing. Condense to fit. If evidence overturns a finding, fix its code and
  all stale records in that change; act, don't ask.
- Keep workflows local-first: narrow checks, then broad, then failures.
- Never commit secrets, generated artifacts, or env files.

## Setup, Commands

- Install/run: `bun install`; `bun run sync-engine/index.ts`
- Develop: `bun run dev` (+ `dev:restart`, `dev:watch`); `bun run build`
- Migrations: `bun run db:generate` / `db:migrate`
- Test: `bun run test` (DOM/server + Chromium); `test:watch` omits browsers.
  `test:browser` uses bare `scripts/test-browser.ts` (Bun no-orphans rejects
  `./`/absolute paths), pins headless, and clears `PWDEBUG`.
- `bun run check` runs all static checks; `format`/`lint:fix` write fixes.
- CI (`.github/workflows/checks.yml`): tests, static checks, build, and
  whitespace checks on Bun 1.3.14 with a frozen lockfile.

## Architecture and Conventions

- Four production workspaces: `solid` owns browser UI, `sync-engine` the Bun
  server/integrations, `runner` the standalone runner, `shared` cross-workspace
  code. The first three import only themselves and `shared`; `shared` imports no
  other workspace; only `scripts` may import `scripts`.
- `server.ts` serves Vite's in-memory browser JS/Tailwind CSS. Authenticated
  WebSockets at `/api/realtime` and `/api/runner/realtime` handle browser state,
  sessions, and runner work; no polling/SSE. `dev:watch` watches production
  source and local `.env`, coalescing bursts into the ignored restart trigger;
  `dev:restart` writes it, while plain `dev` restarts only from it.
  `runner-executable.ts` fingerprints runner source/compiler, builds privately,
  caches in memory, serves `/runner/executable`. Restarts drain active steps and
  queue new work, so sessions may request their own restart. Text handlers
  precompress once, negotiating zstd, Brotli, gzip, deflate; `/favicon.svg`
  revalidates separately with ETag.
- `solid/pages.tsx` renders both server page shells via Solid's SSR runtime;
  `sync-engine/pages.ts` loads it with Vite's SSR runner. The browser app mounts
  from `solid/client.tsx`; routes live in `shared/routes.ts`. Browser tests use
  real Chromium/Tailwind and production mutations, never synthetic layout or
  CSS-only assertions; CI rejects `.only` and zero tests.
- `sync-engine/auth.ts` implements Google OpenID Connect (authorization code
  - PKCE) with HttpOnly state/verifier cookies, fetching the basic profile and
    discarding provider tokens. `sync-engine/auth-store.ts` uses Drizzle/Bun
    SQLite to upsert users and persist seven-day sessions. Primary keys are
    UUIDv7; Google subjects and session cookie tokens are separate unique
    fields; every table has created/updated timestamps, actor IDs, `isDeleted`.
    `shared/database.ts` applies committed `drizzle/` migrations on open;
    `sync-engine/index.ts` injects the persistent connection; the auth factory
    falls back on in-memory SQLite. Shared PKCE, provider parsing, and redirects
    live in `oauth.ts`; cookie/response helpers in `http.ts`. `solid/client.tsx`
    reads `/api/auth/session`, gates the app, posts logout.
- `sync-engine/runner-store.ts` persists runner registrations in `runners`: one
  active registration per machine fingerprint, one default per user.
  `sync-engine/runners.ts` issues hashed opaque setup tokens, owns authenticated
  management and token-authenticated callback APIs, deriving installer commands
  from the request origin. `sync-engine/runner-installer.ts` emits the
  macOS/Linux one-liner: it picks an x64/ARM64 glibc/musl target and starts a
  downloaded standalone executable under `~/.q-mush/runner`; no Bun needed.
  Runners report metadata and 15-second heartbeats over authenticated
  WebSockets, check updates at startup and five-minute intervals, recheck via
  handshake version after restarts, replacing an older socket on reconnect.
  Updates use a source/compiler ETag and SHA-256 digest, atomically replace and
  restart the executable; development restarts drain active sessions first.
  Reinstalling for the same user and machine rotates the registration to its new
  token instead of adding a runner; other registrations stay protected; tokens
  never appear in lists.
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

  `runner/runner-workspace.ts` owns canonical workspace and tool path
  resolution. Tool, skill, model, and effort choices persist per session;
  pickers use canonical schemas. Bounded `read_session` spans transcript
  categories and definitions; `get_session_options` pages spawn choices. Grouped
  tools manage non-blocking owned children, report final messages, resume idle
  parents; `parallel` takes 2+ calls on four ordered workers, bounds output,
  propagates cancellation. `solid/session-transcript.tsx` renders prompts,
  Markdown, code/JSON, diffs/results; session lists by ten. Live streams use
  four-key preparation frames; batches patch once, compacting the oldest or
  protected candidate before eviction. Mutation/stop freezes model/tool UI;
  settlement rebases streams. Disconnect drops unrendered fragments, resyncing
  active paused tools; evicting pending active-tool output also resyncs.
  Barriers and compact 100/session, 1,000/user caps block stale revival and key
  reuse. Epochs stay monotonic while updates or barriers are queued; releasing
  the last barrier reclaims its epoch after updates drain. Terminal cleanup
  can't reset epochs with later barriers. Resets replace models; state events
  coalesce one/frame; ready, health, and commands apply directly; no-op
  snapshots suppress notices. Solid keeps focus/scroll; detail disables document
  anchoring and only bottom-pinned transcripts follow output.
  `agent-model-discovery.ts` queries metadata, signal-cancelable;
  `shared/agent-configuration.ts` owns catalog types/validation. New sessions
  take the default online runner (else first) and credential, first discovered
  model, latest directory, top reported effort. Unknown modalities imply no
  attachment support; choices show provider/Q Mush modalities.
  `solid/custom-select.tsx` shares search normalization, paginates past ten
  items, owns accessible keyboard/focus. Focus mode fills the app viewport (not
  browser Fullscreen), keeping drafts and scroll; its rail overlays on desktop,
  becomes a drawer, collapses on selection, closing with Escape first.
  `shared/agent-prompt.ts` builds the model system prompt and transcript
  display; reasoning summaries persist as `thinking` messages omitted from
  replay. Session and transcript rows sit in `agent_sessions` and
  `agent_messages`; `step_started_at` sets per model step, clears with
  `activeStartedAt` (live Step timer); interrupted processes mark active
  sessions failed for resumption; rebuilds add interrupted tool errors on
  resume.

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
  import-equals, `import()` types, and side-effect imports (except the
  production and browser-test imports of `solid/styles.css`) are rejected.
  First-party code rejects unsafe DOM HTML injection, `dangerouslySetInnerHTML`,
  and HTML-like `Response` bodies; HTML-like data and TSX pass.
- Knip checks every issue type and entry export in separate test/production
  graphs; shipped browser scripts are production roots, tests cannot keep
  production alive, and unused test helpers fail.
- CPD maps all JS/TS extensions to TSX and ignores imports. Its parse-error path
  deliberately matches native CPD's crude whole-file fallback tokenizer.
  Native-token and complete-function alpha matches of ≥20 tokens spanning a line
  boundary fail the zero threshold; alpha ignores locally bound names but
  preserves free names, member APIs, and literals.
- Repository policy: tracked, unignored files have a 20,000-code-point maximum
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
  requests prefer Responses WebSockets, falling back to HTTP streaming;
  OpenRouter and generic endpoints stream chat completions, Anthropic-format
  endpoints Messages events. OpenAI OAuth refreshes its token bundle before
  expiry. Session creation needs an explicit model ID. Catalogs: OpenAI
  `/v1/models`, OpenRouter `/api/v1/models/user`, ChatGPT Codex `/models`, or
  the generic `/models`; Anthropic-format catalogs read `display_name`,
  `max_input_tokens`, `max_tokens`, and the `capabilities` tree
  (`agent-model-discovery-anthropic.ts`: effort and adaptive-thinking support
  are independent; modalities come only from `image_input`/`pdf_input` leaves),
  page via `has_more`/`last_id` at `limit=1000` with stale-cursor and page-count
  guards, probing the endpoint's OpenAI-style listing only where capabilities
  left efforts unknown. Codex parsing retains streamed output-text and
  function-call argument deltas since completed events may omit `output`. Only
  listed efforts are offered; OpenAI's catalog lacks reasoning data. Optional
  reasoning uses `reasoning_effort` for OpenAI and generic chat completions and
  `reasoning.effort` for OpenRouter and Codex Responses; the Anthropic Messages
  format sends `output_config.effort`; unless persisted `adaptiveThinking` is
  false it adds `thinking: {type: "adaptive", display: "summarized"}`. Lazy
  model metadata refresh fills null fields independently and never replaces a
  known capability or output limit while learning the other. It sends neither
  for `none` and maps `minimal` to `low`. Adaptive-only models (Fable) ignore
  `enabled`; newer models default `display` to `omitted` — empty thinking text
  plus a signature while thinking tokens bill. The local proxy tolerates
  tool-loop replay without signed thinking blocks; strict endpoints may not.
  Streamed reasoning deltas group by `output_index` and `summary_index`;
  separate summary parts with paragraphs since completed responses may omit
  them. OpenAI's WebSocket Mode has a 60-minute limit; the canonical
  `websocket_connection_limit_reached` and observed underscore-free variant
  replace the socket once per step, then bound retries, replaying only an
  unpersisted step. Other WebSocket/accepted HTTP interruptions or provider
  errors retry before persistence; replays reset partial UI deltas and exhausted
  WebSockets fall back to HTTP. Permanent errors and aborts do not retry;
  terminal failures persist as non-replayed `error` messages.
- Shell commands require a positive timeout; on macOS/Linux each gets a POSIX
  session; stop/timeout signals only its group. Agent launches and runner
  commands otherwise have no application-owned step, queue, or time limits;
  outside compaction, providers replay the conversation without a timeout.
- Add Knip roots for runtime/standalone entries; exclude tests from production.
  Pin Playwright 1.62.1/Vitest 4.1.10: probes couple to Playwright `<launching>`
  and Vitest launch.
