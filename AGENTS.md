# AGENTS.md

Living project memory.

## Project Snapshot

- Strict-TypeScript ESM Bun/SolidJS; tests live under `test/`, no `src`. `/` is
  the homepage, `/app` the app.

## Working Agreements

- Research provider docs/trackers with brave-search, then probe APIs, schemas,
  and metrics. Call capabilities impossible only with excluding evidence;
  otherwise note an open question.
- Preserve patterns; add tools only as needed; improve touched code, tests,
  docs, performance, security, DX. Ship small now. Integrate every session
  capability with each protocol's native control, recording gaps.
- TDD: fail, implement, refactor green. DRY/KISS: authoritative logic, no
  premature abstraction. Never invent tunables: probe omission, prefer provider
  defaults, else use metadata or docs.
- No reward hacking: never weaken tests, special-case checks, or claim
  unperformed verification; disclose gaps. Fix defects on sight, including
  pre-existing/out-of-scope ones; if harmful, codify why in a test.
- Record decisions, gotchas, and lessons here in the same change; repeated user
  instructions mean a rule is missing. Condense to fit the cap. When evidence
  overturns a finding, fix its code and stale records; act, don't ask.
- Keep workflows local-first: narrow checks per change, broad suites once, then
  rerun the narrowest failure.
- Never commit secrets, generated artifacts, or env files.

## Setup, Commands

- Install/run: `bun install`; `bun run sync-engine/index.ts`
- Develop: `bun run dev` (+ `dev:restart`, `dev:watch`); `bun run build`
- Migrations: `bun run db:generate` / `db:migrate`; tests: `bun run test`
  (DOM/server + Chromium) / `test:watch`; `bun run test:browser` for Chromium.
- `bun run check` runs every static check, each standalone too; `bun run format`
  / `lint:fix` write fixes. CI runs tests, checks, build, and whitespace on Bun
  1.3.14 with a frozen lockfile.

## Architecture and Conventions

- Four enforced production workspaces: `solid` owns browser UI, `sync-engine`
  the Bun server/integrations, `runner` the standalone runner, `shared`
  cross-workspace code. The first three import only themselves and `shared`;
  `shared` imports no other workspace; only `scripts` may import `scripts`.
- `server.ts` serves in-memory Vite JS/Tailwind CSS. Authenticated WebSockets at
  `/api/realtime` and `/api/runner/realtime` handle browser/session/runner work;
  no polling/SSE. `dev:watch` coalesces source and `.env` changes into the
  ignored restart trigger; `dev:restart` writes it. `runner-executable.ts`
  fingerprints, privately builds, caches, and serves `/runner/executable`.
  Restarts drain active steps and queue new work. Text handlers precompress once
  (zstd/Brotli/gzip/deflate); favicon ETags.
- `solid/pages.tsx` renders both server page shells via Solid's SSR runtime;
  `sync-engine/pages.ts` loads it with Vite's SSR runner. The browser app mounts
  from `solid/client.tsx`; routes live in `shared/routes.ts`.
- `auth.ts` implements Google OIDC code + PKCE with HttpOnly state/verifier
  cookies, fetching the profile and discarding provider tokens. `auth-store.ts`
  uses Drizzle/Bun SQLite for users and seven-day sessions. UUIDv7 primary keys,
  Google subjects, and session tokens are separate; tables carry timestamps,
  actor IDs, `isDeleted`. `shared/database.ts` applies migrations; `index.ts`
  injects persistence with an in-memory fallback. Shared OAuth logic lives in
  `oauth.ts`, HTTP helpers in `http.ts`; `solid/client.tsx` gates the app via
  `/api/auth/session` and logout. Browser regressions use real Chromium/Tailwind
  and production state/UI mutations, never synthetic layout or CSS-only checks.
- `runner-store.ts` persists one active runner per machine fingerprint and one
  default per user. `runners.ts` owns authenticated management and opaque hashed
  setup-token callbacks; install commands use request origin.
  `runner-installer.ts` selects x64/ARM64 glibc/musl and runs a standalone
  executable under `~/.q-mush/runner` without Bun. Authenticated WebSockets
  carry metadata and 15-second heartbeats; runners check updates at
  startup/five-minute intervals and by handshake version, replacing older
  sockets. Source/compiler ETag plus SHA-256 updates replace atomically and
  restart; dev drains sessions first. Reinstalling the same user/machine rotates
  its token; others stay protected; tokens never list.
- Browser messages sort by time then ID; live output anchors at its initiator,
  snapshots replace it. `session-agent-read.ts` byte-bounds transcript messages,
  assistant calls, the system prompt, tool definitions.
- `sessions.ts`/`session-store.ts` persist coding sessions; messages accept
  eight 10 MB PNG/JPEG/GIF/WebP images. Sessions track active time, cost, usage,
  context limit; reported charges win. Auto-compaction defaults to 95%; only the
  immediate compactor sees truncation, including persisted manual/idle runs, so
  partial output stays unfinished without retry. Idle sessions compact manually
  or optionally after 30 minutes, soft-deleting into a replayable handoff that
  says deliver drafts, don't re-verify. The always-mounted composer explains
  disabled actions and keeps drafts; local fields debounce to shared state and
  submit flushes first; prefs filter transcript categories. Secrets never reach
  browser/runner payloads. The directory picker uses
  `/api/runners/:id/directories`; each run loads exact-root `AGENTS.md`, else
  `CLAUDE.md`.

  `runner/runner-workspace.ts` owns canonical workspace and tool path
  resolution. Tool, skill, model, and effort choices persist per session;
  pickers use canonical schemas. Bounded `read_session` spans transcript
  categories and definitions; `get_session_options` pages spawn choices. Grouped
  tools manage non-blocking owned children, report final messages, resume idle
  parents; `parallel` takes 2+ calls on four ordered workers, bounds output,
  propagates cancellation. `solid/session-transcript.tsx` renders prompts, tool
  definitions, raw details, Markdown, code/JSON, diffs, and contextual results,
  preserving user line breaks; session lists page by ten. Live sessions use
  `solid/realtime-client.ts`, `solid/session-client.tsx`,
  `solid/session-controller.ts`: model deltas combine once per frame per
  session, other events are immediate, unchanged snapshots suppress
  notifications, keyed messages rerender only changes. The long-lived Solid root
  preserves focus and scroll; the changing session detail is not a document
  scroll anchor, and only bottom-pinned transcripts follow live output.
  `agent-model-discovery.ts` queries metadata, signal-cancelable;
  `shared/agent-configuration.ts` owns catalog types/validation. New sessions
  take the default online runner (else the first) and credential, first
  discovered model, latest working directory, top reported effort. Unknown
  modalities imply no attachment support; choices show provider and Q Mush
  modalities. `solid/custom-select.tsx` shares search normalization, paginates
  past ten items, owns accessible keyboard/focus. Focus mode fills the app
  viewport (not browser Fullscreen), keeping drafts and scroll; its rail
  overlays on desktop, becomes a drawer, collapses on selection, closing with
  Escape first. `shared/agent-prompt.ts` builds the model system prompt and
  transcript display; reasoning summaries persist as `thinking` messages omitted
  from replay. Session and transcript rows sit in `agent_sessions` and
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
  AES-256-GCM encryption and a shared fingerprint over secret, endpoint, and API
  format; API responses expose only metadata; one credential may be the user's
  default across providers. Shared behavior: `provider-credentials.ts`,
  `connected-account-oauth.ts`, the `solid/provider-*` client modules.
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
  Drizzle's optional cross-dialect declarations fail here; app source stays
  fully checked; re-enable after an upstream fix.
- `eslint.config.ts` uses type-aware strict/stylistic `typescript-eslint`
  presets, imports `.gitignore`, bans non-const assertions, enforces exhaustive
  switches and canonical named imports (one declaration per module with inline
  `type` markers). Default imports: only `@eslint/js`, `@tailwindcss/vite`,
  `vite-plugin-solid`; aliases, namespaces, dynamic imports, import attributes,
  import-equals, `import()` types, and side-effect imports (except the
  production and browser-test imports of `solid/styles.css`) are rejected.
  First-party code rejects unsafe DOM HTML injection, `dangerouslySetInnerHTML`,
  and HTML-like `Response` bodies; HTML-like data and TSX pass.
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

- HTTP port 12345 (`PORT` overrides). Google login reads `GOOGLE_CLIENT_ID`,
  `GOOGLE_CLIENT_SECRET`, and optional `GOOGLE_REDIRECT_URI`; the two appear
  together; register the callback
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
  record and clears the payload; provider-side access stays. Fingerprint
  uniqueness includes soft-deleted rows; secret updates throw the duplicate
  error on collision and leave the existing secret intact.
- `shared/ids.ts` owns UUIDv7 generation and defines the `SYSTEM` audit actor;
  user actions use the internal user UUID. Never hard-delete records: set
  `isDeleted`, `updatedAt`, and `updatedById`, excluding soft-deleted rows from
  active queries. Audit actor fields are not foreign keys — `SYSTEM` is not a
  user row.
- Keep HTTP `deflate` zlib-wrapped; Bun's is raw. `page_fetch` proxy upstream
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
  metadata refresh fills null fields independently, preserving known values. It
  sends neither for `none` and maps `minimal` to `low`. Adaptive-only models
  (Fable) ignore `enabled`; newer models default `display` to `omitted` — empty
  thinking text plus a signature while thinking tokens bill. Anthropic replay
  binds the alias, resolved response model, credential/format/endpoint
  provenance, and exact assistant artifact. Failed or unavailable identity
  leaves text-only Messages running but blocks both client-tool execution and
  provider-directed pause follow-up. Exact JSON-safe blocks, including additive
  fields, persist; corrupt metadata warns but leaves transcripts readable.
  Durable client-tool continuations require matching replay and result IDs;
  missing, stale, incomplete, unsupported, or unsigned turns fail closed before
  tool execution. Only empty text drops (whitespace stays but is withheld from
  content and replay together across every trailing text block and fails a pause
  if none remain replayable. `cache_control` marks only text/client `tool_use`,
  scanning backward; trailing replay is resent verbatim. `pause_turn` validates
  resent blocks, replays them/container without duplicate UI, sums usage, caps
  at five continuations, and fails terminal client tools closed when replay
  cannot combine. The local proxy tolerates unsigned tool-loop replay; strict
  endpoints may not. Reasoning deltas group by output/summary index; separate
  summary parts with paragraphs since completed responses may omit them.
  OpenAI's WebSocket Mode has a 60-minute limit; the canonical
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
- Add new runtime roots and standalone build entries to the matching Knip
  configs; exclude test support from production patterns.
