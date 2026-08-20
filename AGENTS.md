# AGENTS.md

- Strict TypeScript ESM Bun/SolidJS; tests under `test/`, no `src`. `/` is home,
  `/app` the app.

## Working Agreements

- Research provider docs with Brave Search, then probe APIs/schemas/metrics;
  call a capability impossible only with excluding evidence, else record an open
  question.
- Preserve patterns; add tools as needed; improve touched code, tests, docs,
  performance, security, DX. Ship now; use TDD, DRY, KISS.
- Never invent tunables: probe omission, prefer provider defaults, else metadata
  or docs.
- Integrate completely: wire every session capability to each protocol's native
  control, recording what it lacks.
- Never weaken tests, special-case checks or claim unperformed verification;
  disclose gaps. Fix defects on sight, including pre-existing ones; codify a
  harmful fix in a test.
- Record decisions/gotchas here in the same change; repeated instructions mean a
  missing rule. Condense to fit the cap. Fix code and stale records when
  evidence overturns a finding; act, don't ask.
- Keep workflows local-first: narrow checks, then broad suites and focused
  reruns. Never commit secrets, generated artifacts or env files.
- Install/run `bun install`, `bun run sync-engine/index.ts`; develop with `dev`
  (+ `dev:restart`, `dev:watch`), `build`, `db:generate`/`db:migrate`.
- Test: `bun run test` (unit + Chromium); `test:watch` omits browsers;
  `test:browser` needs bare `scripts/test-browser.ts` (Bun 1.3.14 no-orphans
  fails elsewhere) and pins headless with `PWDEBUG=0`.
- `bun run check` runs all static checks, each also standalone;
  `format`/`lint:fix` write fixes. `.github/workflows/checks.yml` uses Bun
  1.3.14 and a frozen lockfile with test, static-check, build and whitespace
  jobs.

## Architecture

- Four production workspaces: `solid` owns browser UI, `sync-engine` the Bun
  server, `runner` the standalone runner, `shared` cross-workspace code. The
  first three import only themselves and `shared`, `shared` no workspace and
  only `scripts` imports `scripts`.
- `server.ts` serves Vite's in-memory browser JS/Tailwind CSS. Authenticated
  sockets at `/api/realtime` and `/api/runner/realtime` carry browser state,
  sessions and runner work; no polling/SSE. `dev:watch` watches production
  source and local `.env`, coalescing bursts into the ignored trigger
  `dev:restart` writes; plain `dev` restarts only from that.
  `runner-executable.ts` fingerprints runner source/compiler, then builds,
  caches and serves `/runner/executable`. Development restarts use one
  supervisor-issued absolute 120s deadline (fresh per restart, shared in
  flight), reject new steps and provider/auxiliary requests, report scoped
  active-tool counts, force-park stragglers only after durable handoffs, then
  bound cleanup/termination; repeats escalate and timers name a test-targeted
  purpose. `DevelopmentRestartLifecycle` owns it: a rejected drain keeps
  serving, so it restores maintenance, shutdown state, recovery, the abort
  signal (`SessionRestartAbort`: aborted controllers stay aborted) and the gate,
  clears each session's abandoned server request (a still-gating runner one is
  kept), then reruns handoff recovery and queued launcher unless a final
  shutdown won and only logs; failed chains release. Final shutdown cancels that
  deadline, promotes runner handoffs to a server marker, then stays unbounded,
  fencing live markers from liveness scans. Text handlers precompress once,
  negotiating zstd, Brotli, gzip and deflate; `/favicon.svg` uses ETag.
- `pages.tsx` renders both server page shells via Solid's SSR runtime,
  `pages.ts` loads it with Vite's SSR runner, the app mounts from `client.tsx`
  and `routes.ts` holds routes.
- `auth.ts` implements Google OIDC (code + PKCE) with HttpOnly state/verifier
  cookies, fetching the basic profile and discarding provider tokens.
  `auth-store.ts` uses Drizzle/Bun SQLite to upsert users and keep seven-day
  sessions. Primary keys are UUIDv7, Google subjects and session cookie tokens
  separate unique fields; tables carry created/updated timestamps, actor IDs and
  `isDeleted`. `database.ts` applies committed `drizzle/` migrations on open,
  `index.ts` injects the persistent connection and the auth factory falls back
  on in-memory SQLite. Shared PKCE, provider parsing and redirects live in
  `oauth.ts`, cookie/response helpers in `http.ts`; `client.tsx` reads
  `/api/auth/session`, gates the app and posts logout. Browser regressions use
  real Chromium/Tailwind and production state/UI mutations, never synthetic
  layout or CSS assertions; CI rejects `.only` and empty suites.
- `runner-store.ts` persists registrations in `runners`: one active per machine
  fingerprint, one default per user. `runners.ts` issues hashed opaque setup
  tokens and owns authenticated management plus token callbacks.
  `runner-installer.ts` emits the macOS/Linux one-liner: it picks an x64/ARM64
  glibc/musl target and starts a downloaded standalone executable under
  `~/.q-mush/runner`, needing no Bun. Runners report metadata and 15s heartbeats
  over authenticated sockets, check updates at startup and every five minutes,
  recheck via handshake version after restarts and replace an older socket on
  reconnect; restart IDs clear only after `restart_ready` and operational
  settlement. Updates use a source/compiler ETag and SHA-256 digest, then
  atomically replace and restart the executable; development restarts drain
  first. Reinstalling for the same user/machine rotates the registration to a
  new token instead of adding a runner; others stay protected and tokens out of
  lists.
- Browser messages sort by time then ID; live output anchors at its initiator
  and snapshots replace it. `session-agent-read.ts` byte-bounds
  transcript/system/tool data and keeps positional record/category controls; the
  shared Unicode result bound applies after serialization.
- `sessions.ts`/`session-store.ts` persist coding sessions taking eight 10 MB
  PNG/JPEG/GIF/WebP images per user message and recording active time, cost,
  tokens and context limit, reported charges winning. Auto-compaction defaults
  on at 95%; truncation enters only its immediate compactor context, including
  persisted manual/idle compaction, so partial output stays unfinished without a
  retry mark. Idle sessions compact manually or, opted in, after 30 idle
  minutes; compaction soft-deletes messages into a replayable handoff and
  replays say deliver drafts, don't re-verify. The composer stays mounted across
  statuses, explains unavailable actions and keeps drafts; draft fields echo a
  local signal debounced into the shared draft (submit paths flush first) and
  local prefs filter transcript categories. Provider secrets never reach browser
  or runner payloads. The directory field opens `directory-picker-client.tsx`
  (`/api/runners/:id/directories`). Each run `read_agent_file` loads exact-root
  `AGENTS.md` (else `CLAUDE.md`).

  `runner-workspace.ts` owns canonical workspace/tool path resolution; tool,
  skill, model and effort choices persist per session and pickers use canonical
  schemas. Bounded `read_session` spans transcript categories and definitions
  with positional record pagination; `get_session_options` pages spawn choices.
  Grouped tools manage non-blocking children, report final messages and resume
  idle parents; `parallel` runs 2+ calls on four ordered workers, propagating
  cancellation. `session-transcript.tsx` renders prompts, definitions, raw
  details, Markdown, code/JSON, diffs and results, preserving line breaks; lists
  page by ten. Live sessions use `realtime-client.ts`, `session-client.tsx` and
  `session-controller.ts`: model deltas combine once per frame per session,
  others immediately, unchanged snapshots suppress notifications and keyed
  messages rerender only changes. The long-lived Solid root preserves focus and
  scroll; the changing session detail is no scroll anchor and only bottom-pinned
  transcripts follow live output. `agent-model-discovery.ts` queries metadata,
  signal-cancelable; `agent-configuration.ts` owns catalog types/validation. New
  sessions take the default online runner (else the first) and credential, first
  discovered model, latest directory and top reported effort. Unknown modalities
  imply no attachment support and choices show provider plus Q Mush modalities.
  `custom-select.tsx` shares search normalization, paginates past ten items and
  owns accessible keyboard/focus. Focus mode fills the app viewport (not browser
  Fullscreen), keeping drafts and scroll; its rail overlays on desktop, becomes
  a drawer, collapses on selection and closes with Escape first.
  `agent-prompt.ts` builds the model system prompt and transcript display;
  reasoning summaries persist as replay-omitted `thinking` messages.
  Session/transcript rows sit in `agent_sessions`/`agent_messages`;
  `step_started_at` sets per model step, clearing with `activeStartedAt` (live
  Step timer); interrupted processes mark active sessions failed for resumption
  and rebuilds add resume tool errors.

- `openai.ts`, `openrouter.ts` and `generic-provider.ts` implement model
  connections; generic ones store a normalized base URL, optional key and an
  `apiFormat` toggle: the default OpenAI format uses `/models` plus streamed
  `/chat/completions`, Anthropic sends `x-api-key`/`anthropic-version` to
  `/models` and streamed `/messages` (`anthropic-request.ts`,
  `provider-stream-anthropic.ts`; images/PDFs map to native blocks). Credentials
  live in `provider_credentials` with per-record AES-256-GCM encryption; API
  responses expose metadata only and one may be the user's cross-provider
  default. Shared: `provider-credentials.ts`, `connected-account-oauth.ts`,
  `solid/provider-*`.
- Measure cache hits against the cacheable prefix (total input dilutes with
  fresh tool output); persistent shortfalls are bugs, lone misses noise: writes
  land late and 128-token blocks hide small growth. Codex sockets stay open per
  run (cache-neutral), reconnect on failure and close at run end. UI rates
  divide by summed input minus the final request (summary) or prior step's input
  (per step), clamped at 100%, counting only fully reported steps. OpenAI/Codex
  requests carry the session ID as `prompt_cache_key` and the Codex `session_id`
  header (cache routing); that surface rejects
  `prompt_cache_breakpoint`/`prompt_cache_retention`. OpenRouter and Anthropic
  requests mark one-hour `cache_control` breakpoints on the system prompt,
  transcript tail and Anthropic tool definitions (`provider-prompt-cache.ts`);
  OpenAI rejects markers and generic OpenAI endpoints get neither those nor
  `prompt_cache_key` (Ollama rejects array content, strict servers unknown
  fields). Messages requests send catalog `max_tokens`
  (`agent_sessions.max_output_tokens`), omitted when discovery reported none:
  the real API requires it, proxies don't; the context-window-exceeded beta
  degrades pre-4.5 overshoots to a stop. Length stops persist a non-replayed
  `error` truncation notice (`AgentModelStep.truncation`). Null limits refresh
  lazily (`session-current-model.ts`) only while the credential stays attached,
  propagating stops, not degrading; generic reassignment nulls them to re-probe,
  else they snapshot like context limits.
- `brave-search.ts` implements the authenticated `brave_search` skill and key
  API; users keep multiple encrypted keys in `provider_credentials`, failures
  fall through them in creation order and secrets never reach browser, runner or
  model provider.
- `styles.css` is Tailwind's source. Vitest uses SSR Solid transforms and a
  Happy DOM project; run under Bun since app/tests use Bun APIs and
  `bun:sqlite`. Fixtures stub discovery, never live APIs.
- Strict no-emit bundler TypeScript checks unused/unreachable code; library
  declarations stay unchecked since Drizzle's optional dialect types are broken.
- `eslint.config.ts` uses type-aware strict/stylistic `typescript-eslint`
  presets, imports `.gitignore`, bans non-const assertions and enforces
  exhaustive switches plus canonical named imports (one declaration per module,
  inline `type` markers). Only `@eslint/js`, `@tailwindcss/vite` and
  `vite-plugin-solid` may be default imports; aliases, namespaces, dynamic
  imports, import attributes, import-equals, `import()` types and side-effect
  imports (except production/browser-test `solid/styles.css`) are rejected.
  First-party code rejects unsafe DOM HTML injection, `dangerouslySetInnerHTML`
  and HTML-like `Response` bodies; HTML-like data and TSX pass.
- Knip checks every issue type and entry export in separate test/production
  graphs; shipped browser scripts and standalone build entries are production
  roots, tests cannot keep production alive and unused test helpers fail.
  Severities alone do not activate default-off issue types; keep that list
  complete.
- CPD maps all JS/TS extensions to TSX and ignores imports; its parse-error path
  deliberately matches native CPD's whole-file fallback tokenizer. Native-token
  and complete-function alpha matches of ≥20 tokens spanning a line boundary
  fail the zero threshold; alpha ignores locally bound names but keeps free
  names, member APIs and literals.
- Repository policy scans tracked files: 20,000-code-point maximum (`bun.lock`,
  `drizzle/` excepted), tests only under `test`, no app HTML outside
  `test`/`fixtures`.

## Gotchas

- HTTP port 12345 (`PORT` overrides). Google login reads `GOOGLE_CLIENT_ID`,
  `GOOGLE_CLIENT_SECRET` and optional `GOOGLE_REDIRECT_URI` (the first two
  together); register `http://localhost:12345/api/auth/google/callback` and
  never expose the secret to browser code.
- `DATABASE_PATH` selects SQLite (default `data/q-mush.sqlite`, `data/`
  ignored). Update `shared/database/schema.ts`, register tables in
  `databaseSchema`, `bun run db:generate` and commit the migration plus
  metadata; `db:migrate` runs without HTTP. Drizzle Kit runs its config under
  Node; never transitively import `bun:sqlite`. Drizzle's migration transaction
  nullifies its foreign-key PRAGMAs, so `createDatabase` disables foreign keys
  first, reenabling after.
- Credential storage needs stable private 32-byte base64url `*_CREDENTIAL_KEY`
  secrets per provider and redirect URIs ending in
  `/api/<provider>/oauth/callback`. OpenAI defaults to the Codex public OAuth
  client with a localhost-only callback on its registered
  `http://localhost:1455/auth/callback` (keep that port free); a differing
  `OPENAI_CLIENT_ID` disables that loopback and must allow the configured or
  request-origin callback. OpenRouter OAuth needs no client credentials,
  yielding a user-controlled key. Removal soft-deletes the audit record and
  clears the payload; provider access stays.
- `ids.ts` owns UUIDv7 generation and the `SYSTEM` audit actor; user actions use
  the internal user UUID. Never hard-delete: set `isDeleted`, `updatedAt` and
  `updatedById`, excluding soft-deleted rows from active queries. Audit actor
  fields are no foreign keys — `SYSTEM` is no user row.
- Keep HTTP `deflate` zlib-wrapped; Bun's is raw. page_fetch proxy upstream
  connects bound at 10s, under the tool deadline.
- Never run the full suite parallel to lint or repository scans; tooling-policy
  tests probe `solid`.
- Installer commands use the HTTP request origin: connect other machines through
  a reachable one, not `localhost`; removal leaves `~/.q-mush/runner`.
- Bun 1.3.14's `Bun.build({ compile: ... })` writes the binary only to
  `compile.outfile` (`outputs[0]` is bundled JS): build in a temp directory and
  read it before cleanup.
- Bare-metal file tools resolve relative paths against the runner workspace but
  accept any runner-accessible path; container file tools and attachment records
  stay contained (they run on the host). Container shells run as root in a
  disposable per-session Arch container (default `archlinux:latest`) with
  network and default caps, so pacman works; only the workspace mounts and
  `read` pages its source. The directory picker browses beyond that workspace
  with runner permissions, returns bounded metadata, times out stalls, maps HTTP
  cancellation to a browse error and propagates agent-tool cancellation.
  Stopping a session aborts its model request and cancels runner commands,
  ending any shell. OpenAI API-key and OAuth requests prefer Responses
  WebSockets, falling back to HTTP streaming; OpenRouter and generic endpoints
  stream chat completions, Anthropic-format ones Messages events. OpenAI OAuth
  refreshes tokens before expiry and session creation needs an explicit model
  ID. Catalogs: OpenAI `/v1/models`, OpenRouter `/api/v1/models/user`, Codex
  `/models` or generic `/models`; Anthropic catalogs read `display_name`,
  `max_input_tokens`, `max_tokens` and the `capabilities` tree
  (`agent-model-discovery-anthropic.ts`: effort and adaptive-thinking support
  are independent, modalities come only from `image_input`/`pdf_input` leaves),
  page via `has_more`/`last_id` at `limit=1000` with stale-cursor and page-count
  guards, probing the endpoint's OpenAI-style listing only where capabilities
  left efforts unknown. Codex parsing retains streamed output-text and
  function-call argument deltas since completed events may omit `output`. Only
  listed efforts are offered; OpenAI's catalog lacks reasoning data. Optional
  reasoning uses `reasoning_effort` for OpenAI/generic chat completions,
  `reasoning.effort` for OpenRouter/Codex Responses and `output_config.effort`
  for Anthropic Messages, which unless persisted `adaptiveThinking` is false
  adds `thinking: {type: "adaptive", display: "summarized"}`. Lazy metadata
  refresh fills null fields independently and never replaces a known capability
  or output limit while learning the other; it sends neither for `none` and maps
  `minimal` to `low`. Adaptive-only models (Fable) ignore `enabled`; newer ones
  default `display` to `omitted` — empty thinking text plus a signature while
  thinking tokens bill. The local proxy tolerates tool-loop replay without
  signed thinking blocks; strict endpoints may not. Streamed reasoning deltas
  group by `output_index`/`summary_index`; separate summary parts with
  paragraphs since completed responses may omit them. OpenAI's WebSocket Mode
  has a 60-minute limit; the canonical `websocket_connection_limit_reached` and
  observed underscore-free variant replace the socket once per step, then bound
  retries, replaying only an unpersisted step. Other WebSocket/HTTP
  interruptions or provider errors retry before persistence; replays reset
  partial UI deltas and exhausted sockets fall back to HTTP. Permanent errors
  and aborts do not retry; terminal failures persist as non-replayed `error`
  messages.
- Shell commands require a positive timeout; on macOS/Linux each gets a POSIX
  session and stop/timeout signals only its group. Beyond the global tool
  limits, agent launches and runner commands have no application-owned step or
  queue limits; outside compaction providers replay untimed.
- Tools use persisted user settings, defaulting to 30 minutes and 20,000 Unicode
  characters. Writes upsert on the partial index; keep its conflict predicate
  schema-aligned. Each run snapshots both for its prompt, schemas, engine/runner
  deadline, sleep, skills/session tools and final result bound; changes apply
  next run and realtime updates stay user-scoped. Loading clears its timer and
  aborts its signal on settlement; `parallel` shares one budget and
  `ask_questions` waits outside it. One truncation path/notice owns model-facing
  output, positional pagination keeps valid continuation envelopes and
  input/security/transport bounds stay separate. Write/edit cancellation is
  best-effort post-mutation.
- Exclude tests from Knip's production graph. Pin Playwright 1.62.1/Vitest
  4.1.10: probes couple to Playwright `<launching>` and Vitest launch.
