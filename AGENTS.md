# AGENTS.md

Project memory.

## Project Snapshot

- Strict TypeScript ESM Bun/SolidJS; tests live under `test/`, no `src`. `/` is
  home, `/app` the app.

## Working Agreements

- Call capabilities impossible only with excluding evidence; else record an open
  question.
- Preserve patterns; improve touched code. TDD: fail first, implement, refactor
  green; keep one authoritative path, avoiding premature abstraction.
- Research provider docs via Brave Search; probe APIs. For tunables probe
  omission, prefer provider defaults, then metadata/docs.
- Fix defects on sight, even pre-existing; if harmful, codify why in a test.
  Never weaken checks or claim unperformed verification; disclose gaps.
- Integrate completely: wire every session capability to each protocol's native
  control, recording what it lacks.
- Record decisions and lessons here unprompted; repeated guidance means a
  missing rule. Condense to fit. If evidence overturns a finding, fix its code
  and stale records then; act, don't ask.
- Keep workflows local-first: narrow checks, then broad, then failures. Never
  commit secrets, generated artifacts or env files.

## Setup, Commands

- Install/run: `bun install`; `bun run sync-engine/index.ts`; develop with `dev`
  (+ `dev:restart`, `dev:watch`), `build`, `db:generate`/`db:migrate`.
- Test: `bun run test` (DOM/server + Chromium); `test:watch` omits browsers.
  `test:browser` uses bare `scripts/test-browser.ts` (Bun no-orphans rejects
  other paths), pins headless and clears `PWDEBUG`.
- `bun run check` runs all static checks; `format`/`lint:fix` write fixes. CI
  (`checks.yml`) runs tests, static checks, build and whitespace on Bun 1.3.14
  with a frozen lockfile. Pin Playwright 1.62.1/Vitest 4.1.10: probes couple to
  Playwright `<launching>` and Vitest launch.

## Architecture

- Workspaces: `solid` owns browser UI, `sync-engine` the Bun server, `runner`
  the standalone runner, `shared` cross-workspace code. The first three import
  only themselves and `shared`, `shared` imports none and only `scripts` imports
  `scripts`.
- `server.ts` serves Vite's in-memory browser JS/Tailwind CSS. Authenticated
  sockets at `/api/realtime` and `/api/runner/realtime` carry browser state and
  runner work; no polling/SSE. `dev:watch` watches production source and `.env`,
  coalescing bursts into the ignored trigger `dev:restart` writes; plain `dev`
  restarts only from it. `runner-executable.ts` fingerprints runner
  source/compiler, builds privately, caches, serves `/runner/executable`.
  Restarts drain active steps and queue work, so sessions may request their own;
  `DevelopmentRestartLifecycle` bounds a dev one with one supervisor 120s
  deadline (fresh per restart, shared in flight), rejecting new steps and
  provider/auxiliary requests, reporting scoped active-tool counts,
  force-parking stragglers after durable handoffs, then bounding cleanup,
  repeats escalating and purpose-named timers. A rejected drain keeps serving,
  restoring maintenance, shutdown state, recovery, the abort signal
  (`SessionRestartAbort`: requests capture one signal identity across awaits;
  aborted controllers stay aborted) and the gate, clearing each session's
  abandoned server request (still-gating runner ones stay), then rerunning
  handoff recovery and the queued launcher unless shutdown won and only logs;
  failed chains release. Final shutdown cancels it, promotes runner handoffs to
  a server marker, runs unbounded, fencing live markers from liveness scans.
  Text handlers precompress once, negotiating zstd, Brotli, gzip, deflate;
  `/favicon.svg` revalidates by ETag.
- `pages.tsx` renders both server page shells via Solid's SSR runtime,
  `pages.ts` loads it with Vite's SSR runner, the app mounts from `client.tsx`
  and `routes.ts` holds routes. Browser tests use real Chromium/Tailwind and
  production mutations, never synthetic layout or CSS assertions; CI rejects
  `.only` and empty suites.
- `auth.ts` implements Google OIDC (code + PKCE) with HttpOnly state/verifier
  cookies, fetching the basic profile, discarding provider tokens.
  `auth-store.ts` uses Drizzle/Bun SQLite to upsert users and keep seven-day
  sessions; keys are UUIDv7, Google subjects and session cookie tokens separate
  unique fields and tables carry created/updated timestamps, actor IDs and
  `isDeleted`. `database.ts` applies committed `drizzle/` migrations on open,
  `index.ts` injects the persistent connection and the auth factory falls back
  on in-memory SQLite. Shared PKCE, provider parsing and redirects live in
  `oauth.ts`, cookie helpers in `http.ts`; `client.tsx` reads
  `/api/auth/session`, gates the app and posts logout.
- `runner-store.ts` persists registrations in `runners`: one active per machine
  fingerprint, one default per user. `runners.ts` issues hashed opaque setup
  tokens and owns authenticated management plus token callbacks, deriving
  installers from the origin. `runner-installer.ts` emits the macOS/Linux
  one-liner: it picks an x64/ARM64 glibc/musl target and starts a downloaded
  standalone executable under `~/.q-mush/runner`, needing no Bun. Runners report
  metadata and 15s heartbeats over authenticated sockets, check updates at
  startup and every five minutes, recheck by handshake version after restarts
  and replace an older socket on reconnect; restart IDs clear only after
  `restart_ready` and operational settlement. Updates use source/compiler ETags
  and SHA-256, then atomically replace and restart it; dev restarts drain
  sessions first. Reinstalling for the same user/machine rotates the
  registration instead of adding a runner; others stay protected and tokens
  never list.
- Browser messages sort by time then ID; live output anchors at its initiator
  and snapshots replace it. `session-agent-read.ts` keeps positional
  record/category controls; the shared Unicode result bound applies after
  serialization.
- `sessions.ts`/`session-store.ts` persist coding sessions taking eight 10 MB
  images (PNG/JPEG/GIF/WebP) per message and recording active time, cost, tokens
  and context limit; reported charges win. Auto-compaction defaults on at 95%;
  truncation enters only its immediate compactor context, including persisted
  manual/idle compaction, so partial output stays unfinished without a retry
  mark. Idle sessions compact manually or, opted in, at 30 idle minutes;
  compaction soft-deletes messages into a replayable handoff and replays deliver
  drafts without re-verifying. The composer stays mounted across statuses,
  explaining unavailable actions and keeping drafts; draft fields echo a local
  signal debounced into the shared draft (submit paths flush first) and local
  prefs filter transcript categories. Provider secrets never reach
  browser/runner payloads. The directory field opens
  `directory-picker-client.tsx` (`/api/runners/:id/directories`); each run
  `read_agent_file` loads root `AGENTS.md` (else `CLAUDE.md`).

  `runner-workspace.ts` owns canonical workspace/tool path resolution; tool,
  skill, model and effort choices persist per session, pickers using canonical
  schemas. `read_session` spans transcript categories and definitions with
  positional pagination; `get_session_options` pages spawn choices. Grouped
  tools manage non-blocking children, deliver final messages, resume idle
  parents; `parallel` runs 2+ calls on four ordered workers, propagating
  cancellation. `session-transcript.tsx` renders prompts, definitions
  (`session-tool-definitions.tsx`), Markdown, code/JSON and diffs/results,
  keeping line breaks; lists page by ten. Live streams use four-key preparation
  frames and batches patch once, compacting the oldest or protected one.
  `sync_tools` fan-out, pending buffers and keyed snapshots stay bounded
  (`realtime-stream-buffer-limits.ts`); reconnects dedupe resyncs. Mutation/stop
  freezes model/tool UI, settlement rebases streams, disconnect drops unrendered
  fragments and resyncs paused tools. An eviction always requests a snapshot, so
  an undelivered terminal can't clear a running row. Barriers plus 100/session,
  1,000/user caps block stale revival and key reuse. Epochs stay monotonic while
  updates or barriers queue; releasing the last reclaims its epoch once updates
  drain and terminal cleanup can't reset epochs with later barriers. Resets
  replace models, state events coalesce one/frame, ready, health, command,
  restart-progress and user tool-setting events apply directly and no-op
  snapshots suppress notices. Solid preserves focus/scroll, detail disables
  document anchoring and only bottom-pinned transcripts follow output.
  `agent-model-discovery.ts` queries metadata, signal-cancelable, and
  `agent-configuration.ts` owns catalog types/validation. New sessions take the
  default online runner (else first) and credential, first discovered model,
  latest directory and top effort. Unknown modalities imply no attachment
  support; choices show provider/Q Mush modalities. `custom-select.tsx` shares
  search normalization, paginates past ten items, owning accessible
  keyboard/focus. Focus mode fills the app viewport (not browser Fullscreen),
  keeping drafts and scroll; its rail overlays on desktop, becomes a drawer,
  collapses on selection, closing with Escape first. `agent-prompt.ts` builds
  the system prompt and transcript display; reasoning summaries persist as
  replay-omitted `thinking` messages. Session/transcript rows sit in
  `agent_sessions`/`agent_messages`; `step_started_at` sets per model step,
  clearing with `activeStartedAt` (Step timer); interrupted processes mark
  active sessions failed for resumption; rebuilds add resume tool errors.

- `openai.ts`, `openrouter.ts`, `generic-provider.ts` implement model
  connections; generic ones store a normalized base URL, optional key and an
  `apiFormat` toggle: the default OpenAI format uses `/models` plus streamed
  `/chat/completions`, Anthropic sends `x-api-key`/`anthropic-version` to
  `/models` and streamed `/messages` (`anthropic-request.ts`,
  `provider-stream-anthropic.ts`; images/PDFs map to native blocks). Credentials
  live in `provider_credentials` with per-record AES-256-GCM encryption; APIs
  expose metadata only; one may be the user's cross-provider default. Shared:
  `provider-credentials.ts`, `connected-account-oauth.ts`, `provider-*`.
- Measure cache hits against the cacheable prefix (total input dilutes with
  fresh tool output); persistent shortfalls are bugs, lone misses noise. Codex
  sockets stay open per run (cache-neutral), reconnect on failure and close at
  end. UI rates divide summed input minus the final request (summary) or prior
  step's input (per step), clamped at 100% over fully reported steps.
  OpenAI/Codex requests carry the session ID as `prompt_cache_key` and the Codex
  `session_id` header (cache routing); that surface rejects
  `prompt_cache_breakpoint`/`prompt_cache_retention`. OpenRouter and Anthropic
  requests mark one-hour `cache_control` breakpoints on the system prompt,
  transcript tail and Anthropic tool definitions (`provider-prompt-cache.ts`);
  OpenAI rejects markers and generic OpenAI endpoints get neither those nor
  `prompt_cache_key` (Ollama rejects array content, strict servers unknown
  fields). Messages requests send catalog `max_tokens`
  (`agent_sessions.max_output_tokens`), omitted when discovery reported none:
  the real API requires it, proxies don't; the context-window-exceeded beta
  degrades pre-4.5 overshoots to a stop. Length stops persist a non-replayed
  `error` notice (`AgentModelStep.truncation`). Null limits refresh lazily
  (`session-current-model.ts`) while the credential stays attached, propagating
  stops, not degrading; generic reassignment nulls them to re-probe, else they
  snapshot like context sizes.
- `brave-search.ts` implements the authenticated `brave_search` skill and key
  API; users keep multiple encrypted keys in `provider_credentials`, failures
  fall through them in creation order; keys stay server-side.
- `client.tsx` is the browser entry, `pages.tsx` owns SSR shells and
  `styles.css` is Tailwind's source. Vitest uses an SSR Solid transform plus a
  Happy DOM project; run it under Bun since tests/app modules use Bun APIs and
  `bun:sqlite`; fixtures stub discovery, not live providers.
- `tsconfig.json` sets strict, no-emit, bundler-style checking with
  unused/unreachable diagnostics; library declaration checking stays off because
  Drizzle's optional cross-dialect declarations fail here, so re-enable it after
  an upstream fix.
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
  graphs; shipped browser scripts are production roots, tests can't keep
  production alive and unused helpers fail. Add roots for runtime/standalone
  entries, exclude tests from production and keep the included-issue list
  complete: severities alone don't enable default-off types.
- CPD maps JS/TS extensions to TSX and ignores imports; its parse-error path
  matches native CPD's whole-file fallback tokenizer. Native-token and
  complete-function alpha matches of ≥20 tokens across a line boundary fail the
  zero threshold; alpha ignores locally bound names but keeps free names, member
  APIs and literals.
- Repo policy: tracked, unignored files cap at 20,000 code points (`bun.lock`,
  `drizzle/` excepted), tests only under `test` and no app HTML outside
  `test`/`fixtures`.

## Gotchas

- HTTP port 12345 (`PORT` overrides). Google login reads `GOOGLE_CLIENT_ID` and
  `GOOGLE_CLIENT_SECRET` together, plus optional `GOOGLE_REDIRECT_URI`; register
  `http://localhost:12345/api/auth/google/callback` and never expose the secret
  to browsers.
- `DATABASE_PATH` selects SQLite (default ignored `data/q-mush.sqlite`). Update
  `shared/database/schema.ts`, register tables in `databaseSchema`, run
  `bun run db:generate` and commit migration plus metadata; `db:migrate` runs
  without HTTP. Drizzle Kit runs its config under Node, so never transitively
  import `bun:sqlite`. Its migration transaction nullifies foreign-key PRAGMAs,
  so `createDatabase` disables foreign keys first, reenabling after.
- Credential storage needs private, stable 32-byte base64url `*_CREDENTIAL_KEY`
  secrets per provider and redirect URIs ending in
  `/api/<provider>/oauth/callback`. OpenAI defaults to the public Codex OAuth
  client with a localhost-only callback at `http://localhost:1455/auth/callback`
  (keep its port free); a different `OPENAI_CLIENT_ID` disables that loopback
  and must allow the configured or request-origin callback. OpenRouter OAuth
  needs no client credentials and yields a user-controlled key. Removal
  soft-deletes the audit record and clears its payload; provider access remains.
- `ids.ts` owns UUIDv7 generation and the `SYSTEM` audit actor; user actions use
  the internal user UUID. Never hard-delete: set `isDeleted`, `updatedAt` and
  `updatedById`, excluding soft-deleted rows from active queries. Audit actor
  fields aren't foreign keys — `SYSTEM` is no user.
- Keep HTTP `deflate` zlib-wrapped; Bun's is raw. page_fetch proxy upstream
  connects bound at 10s, under the tool deadline. Don't run the full suite
  alongside lint or repo scans; tooling-policy tests probe `solid`.
- Install commands use the request origin: connect other machines through a
  reachable one, not `localhost`; removal leaves `~/.q-mush/runner`. Bun
  1.3.14's `Bun.build({ compile: ... })` writes the binary only to
  `compile.outfile` (`outputs[0]` is bundled JS): build in a temp dir, read it
  before cleanup.
- Bare-metal tools accept any runner-accessible path; relative ones use the
  workspace. Container file tools and attachments run on the host, staying
  contained. Container shells are disposable per-session root Arch
  (`archlinux:latest` by default) with network/default caps and only the
  workspace mounted, so pacman works; `read` pages files. Directory browsing
  escapes the workspace, returns bounded metadata, times out stalls, maps HTTP
  cancellation to a browse error and propagates tool cancellation. Stopping
  aborts the model request and runner commands, ending any shell. OpenAI
  API-key/OAuth prefer Responses sockets, else HTTP streaming; OpenRouter and
  generic endpoints stream chat completions, Anthropic ones Messages events.
  OpenAI OAuth refreshes tokens before expiry; sessions need an explicit model
  ID. Catalogs: OpenAI `/v1/models`, OpenRouter `/api/v1/models/user`, Codex or
  generic `/models`; Anthropic ones read `display_name`, `max_input_tokens`,
  `max_tokens` and `capabilities` (`agent-model-discovery-anthropic.ts`: effort
  and adaptive-thinking support are independent, modalities coming only from
  `image_input`/`pdf_input` leaves), page via `has_more`/`last_id` at
  `limit=1000` with stale-cursor/page-count guards and probe the endpoint's
  OpenAI listing only where capabilities left efforts unknown. Codex parsing
  keeps streamed output-text and function-call deltas since completed events may
  omit `output`; only listed efforts are offered and OpenAI's catalog lacks
  reasoning data. Optional reasoning uses `reasoning_effort` for OpenAI/generic
  chat completions, `reasoning.effort` for OpenRouter/Codex Responses and
  `output_config.effort` for Anthropic Messages, which unless persisted
  `adaptiveThinking` is false adds
  `thinking: {type: "adaptive", display: "summarized"}`. Lazy metadata refresh
  fills null fields independently, never replacing a known capability or output
  limit while learning the other; it sends neither for `none` and maps `minimal`
  to `low`. Adaptive-only models (Fable) ignore `enabled`; newer ones default
  `display` to `omitted` — empty thinking text plus a signature while thinking
  tokens bill. The local proxy tolerates tool-loop replay without signed
  thinking blocks; strict endpoints might not. Streamed reasoning deltas group
  by `output_index`/`summary_index`; separate summary parts with paragraphs
  since completed responses may omit them. OpenAI's WebSocket Mode has a
  60-minute limit; the canonical `websocket_connection_limit_reached` and
  observed underscore-free variant replace the socket once per step, then bound
  retries, replaying only an unpersisted step. Other socket/HTTP interruptions
  or provider errors retry before persistence; replays reset partial UI deltas,
  exhausted sockets fall back to HTTP and permanent errors or aborts don't
  retry, persisting as non-replayed `error` messages.
- Tools persist user settings (`tool-settings*.ts`), defaulting to 30 minutes
  and 20,000 Unicode characters; writes upsert on a partial index whose
  predicate must match the schema. Runs snapshot both for the prompt, schemas,
  engine/runner deadline, sleep, skills/session tools and result bound; changes
  apply next run. Loading clears its timer and aborts on settlement; `parallel`
  shares one budget, `ask_questions` waiting outside. One truncation path/notice
  owns model-facing output, positional pagination preserves continuation
  envelopes and input/security/transport bounds stay separate. Shell has a
  runner timer and each POSIX command gets a session whose group is signaled on
  stop/timeout. Write/edit cancellation is best-effort post-mutation and outside
  compaction provider replay is untimed.
