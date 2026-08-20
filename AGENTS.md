# AGENTS.md

Project memory. Strict TypeScript ESM Bun/SolidJS; tests under `test/`; `/` is home, `/app` the app.

## Working Agreements

- Call capabilities impossible only with excluding evidence; else record an open
  question.
- Preserve patterns; improve touched code.
- TDD: fail first, implement, refactor green. Keep one authoritative path; avoid
  premature abstraction.
- Research provider docs via Brave Search; probe APIs. For tunables, probe
  omission, prefer provider defaults, then metadata/docs.
- Fix defects on sight, even pre-existing; if harmful, codify why in a test.
- Integrate completely the first time: wire every session capability to each
  protocol's native control, recording what a protocol lacks.
- Never weaken checks or claim unperformed verification; disclose gaps.
- Record decisions and lessons here unprompted; repeated guidance means a rule
  is missing. Condense to fit. If evidence overturns a finding, fix its code and
  stale records then; act, don't ask.
- Keep workflows local-first: narrow checks, then broad, then failures.
- Never commit secrets, generated artifacts, or env files.

## Setup, Commands

- Install/run: `bun install`; `bun run sync-engine/index.ts`
- Develop: `bun run dev` (+ `dev:restart`, `dev:watch`); `bun run build`
- Migrations: `bun run db:generate` / `db:migrate`
- Test: `bun run test` (DOM/server + Chromium); `test:watch` omits browsers.
  `test:browser` uses bare `scripts/test-browser.ts` (Bun no-orphans rejects
  `./`/absolute paths), pins headless, clears `PWDEBUG`.
- `bun run check` runs all static checks; `format`/`lint:fix` write fixes.
- CI (`checks.yml`): tests, static checks, build, whitespace on Bun 1.3.14,
  frozen lockfile.

## Architecture

- Four production workspaces: `solid` owns browser UI, `sync-engine` the Bun
  server/integrations, `runner` the standalone runner, `shared` cross-workspace
  code. The first three import only themselves and `shared`; `shared` imports
  none; only `scripts` may import `scripts`.
- `server.ts` serves Vite's in-memory browser JS/Tailwind CSS. Authenticated
  WebSockets at `/api/realtime` and `/api/runner/realtime` handle browser state
  and runner work; no polling/SSE. `dev:watch` watches production source and
  `.env`, coalescing bursts into the ignored restart trigger; `dev:restart`
  writes it, plain `dev` restarts only from it. `runner-executable.ts`
  fingerprints runner source/compiler, builds privately, caches in memory,
  serves `/runner/executable`. Restarts drain active steps, queue new work, so
  sessions may request their own restart. Text handlers precompress once,
  negotiating zstd, Brotli, gzip, deflate; `/favicon.svg` revalidates by ETag.
- `solid/pages.tsx` renders both server page shells via Solid's SSR runtime;
  `sync-engine/pages.ts` loads it with Vite's SSR runner. The app mounts from
  `solid/client.tsx`; routes live in `shared/routes.ts`. Browser tests use real
  Chromium/Tailwind and production mutations, never synthetic layout or CSS-only
  assertions; CI rejects `.only` and zero tests.
- `sync-engine/auth.ts` implements Google OpenID Connect (authorization code
  - PKCE) with HttpOnly state/verifier cookies, fetching the basic profile and
    discarding provider tokens. `auth-store.ts` uses Drizzle/Bun SQLite,
    upserting users and persisting seven-day sessions. Primary keys are UUIDv7;
    Google subjects and session cookie tokens are separate unique fields; every
    table has created/updated timestamps, actor IDs, `isDeleted`.
    `shared/database.ts` applies committed `drizzle/` migrations on open;
    `sync-engine/index.ts` injects the persistent connection; the auth factory
    falls back on in-memory SQLite. Shared PKCE, provider parsing, redirects
    live in `oauth.ts`; cookie helpers in `http.ts`. `solid/client.tsx` reads
    `/api/auth/session`, gates the app, posts logout.
- `sync-engine/runner-store.ts` persists runner registrations in `runners`: one
  active registration per machine fingerprint, one default per user.
  `runners.ts` issues hashed opaque setup tokens, owns authenticated management
  and token-authenticated callbacks, deriving installers from the origin.
  `runner-installer.ts` emits the macOS/Linux one-liner: it picks an x64/ARM64
  glibc/musl target and starts a downloaded standalone executable under
  `~/.q-mush/runner`; Bun not needed. Runners report metadata and 15-second
  heartbeats over authenticated WebSockets, check updates at startup/five-minute
  intervals, recheck via handshake version after restarts, replacing an older
  socket on reconnect. Updates use source/compiler ETags and SHA-256, atomically
  replace and restart it; dev restarts drain sessions first. Reinstalling for
  the same user and machine rotates the registration to its new token instead of
  adding a runner; others stay protected; tokens never list.
- Browser messages sort by time then ID; live output anchors at its initiator,
  snapshots replace it. `session-agent-read.ts` keeps positional record/category
  controls; the shared Unicode result bound applies after serialization.
- `sync-engine/sessions.ts` and `session-store.ts` persist coding sessions.
  Messages take eight 10 MB PNG/JPEG/GIF/WebP images as multimodal input.
  Sessions record active time, cost, token usage, context limit; reported
  charges win. Auto-compaction defaults on at 95%; truncation enters only its
  immediate compactor context, including persisted manual/idle compaction, so
  partial output stays unfinished without a retry mark. Idle sessions compact
  manually or, opted in, at 30 idle minutes; compaction soft-deletes messages
  into a replayable handoff; replays deliver drafts, skip re-verifying. The
  composer stays mounted across statuses, explaining unavailable actions,
  keeping drafts; draft fields echo a local signal debounced into the shared
  draft — submit paths flush first; local prefs filter transcript categories.
  Provider secrets never reach browser/runner payloads. The directory field
  opens `directory-picker-client.tsx` (`/api/runners/:id/directories`). Each
  run, `read_agent_file` loads root `AGENTS.md` (else `CLAUDE.md`).

  `runner/runner-workspace.ts` owns canonical workspace and tool path
  resolution. Tool, skill, model, and effort choices persist per session;
  pickers use canonical schemas. `read_session` spans transcript categories and
  definitions with positional record pagination; `get_session_options` pages
  spawn choices. Grouped tools manage non-blocking owned children, deliver final
  messages, and resume idle parents; `parallel` uses four ordered workers for 2+
  calls and propagates cancellation. `session-transcript.tsx` renders prompts,
  definitions (`session-tool-definitions.tsx`), Markdown, code/JSON,
  diffs/results, keeping user line breaks; lists page by ten. Live streams use
  four-key preparation frames; batches patch once, compacting the oldest or
  protected candidate before eviction. `sync_tools` fan-out, pending buffers,
  and keyed snapshots stay bounded (`realtime-stream-buffer-limits.ts`);
  reconnects dedupe resyncs. Mutation/stop freezes model/tool UI; settlement
  rebases streams. Disconnect drops unrendered fragments, resyncs paused tools.
  Every eviction requests a snapshot: an undelivered terminal can't clear a
  running row. Barriers and 100/session, 1,000/user caps block stale revival and
  key reuse. Epochs stay monotonic while updates or barriers are queued;
  releasing the last barrier reclaims its epoch after updates drain. Terminal
  cleanup can't reset epochs having later barriers. Resets replace models; state
  events coalesce one/frame; ready, health, commands, and user-scoped
  tool-setting updates apply directly; no-op snapshots suppress notices. Solid
  preserves focus/scroll; detail disables document anchoring, and only
  bottom-pinned transcripts follow output. `agent-model-discovery.ts` queries
  metadata, signal-cancelable; `agent-configuration.ts` owns catalog
  types/validation. New sessions take the default online runner (else first) and
  credential, first discovered model, latest directory, top reported effort.
  Unknown modalities imply no attachment support; choices show provider/Q Mush
  modalities. `custom-select.tsx` shares search normalization, paginates past
  ten items, owns accessible keyboard/focus. Focus mode fills the app viewport
  (not browser Fullscreen), keeping drafts and scroll; its rail overlays on
  desktop, becomes a drawer, collapses on selection, closing with Escape first.
  `agent-prompt.ts` builds the system prompt and transcript display; reasoning
  summaries persist as `thinking` messages omitted in replay. Session/transcript
  rows sit in `agent_sessions` and `agent_messages`; `step_started_at` sets per
  model step, clears with `activeStartedAt` (live Step timer); interrupted
  processes mark active sessions failed for resumption; rebuilds add interrupted
  tool errors on resume. While running, server-derived `runtimePending` is
  `startup`, `runner_command`, `engine_tool`, `provider_request`, or
  `provider_admission`; the codec rejects others; the UI shows it.

- `openai.ts`, `openrouter.ts`, `generic-provider.ts` implement model
  connections. Generic providers store a normalized base URL, optional key, and
  an `apiFormat` toggle: the default OpenAI format uses `/models` plus streamed
  `/chat/completions`; the Anthropic format sends `x-api-key` and
  `anthropic-version` to `/models` and streamed `/messages`
  (`anthropic-request.ts`, `provider-stream-anthropic.ts`; images/PDFs map to
  native blocks). Credentials live in `provider_credentials` with per-record
  AES-256-GCM encryption; APIs expose metadata only; one credential may be the
  user's default across providers. Shared behavior: `provider-credentials.ts`,
  `connected-account-oauth.ts`, the `solid/provider-*` client modules.
- Measure cache hits against the cacheable prefix (total input dilutes with
  fresh tool output); persistent shortfalls are bugs, lone misses noise. Codex
  sockets stay open per run (cache-neutral), reconnect on failure, close at end.
  UI rates divide by summed input minus the final request (summary) or prior
  step's input (per step), clamped at 100%, counting fully reported steps.
  OpenAI/Codex requests carry the session ID as `prompt_cache_key` and the Codex
  `session_id` header (cache routing); that surface rejects
  `prompt_cache_breakpoint`/`prompt_cache_retention`. OpenRouter and
  Anthropic-format requests mark one-hour `cache_control` breakpoints on the
  system prompt, transcript tail, and Anthropic tool definitions
  (`provider-prompt-cache.ts`); OpenAI rejects markers, generic OpenAI-format
  endpoints get neither markers nor `prompt_cache_key` (Ollama rejects array
  content; strict servers reject unknown fields). Messages requests send catalog
  `max_tokens` (`agent_sessions.max_output_tokens`), omitted when discovery
  reported none — the real API requires it, proxies don't; the
  context-window-exceeded beta degrades pre-4.5 overshoots to a stop reason.
  Length stops persist a non-replayed `error` notice
  (`AgentModelStep.truncation`). Null limits refresh lazily
  (`session-current-model.ts`) only while the credential stays attached,
  propagating stops, not degrading; generic reassignment nulls them to re-probe,
  else they snapshot like context sizes.
- `sync-engine/brave-search.ts` implements the authenticated server-side
  `brave_search` skill and key API. Users keep multiple encrypted keys in
  `provider_credentials`; failures fall through them in creation order; keys
  stay server-side.
- `solid/client.tsx` is the browser entry; `pages.tsx` owns SSR shells,
  `styles.css` is Tailwind's source. Vitest uses an SSR Solid transform for
  string rendering and a Happy DOM project for post-mount reactivity; run it
  under Bun — tests/app modules use Bun APIs and `bun:sqlite`. Fixtures stub
  discovery; tests never hit live providers.
- `tsconfig.json` configures strict, no-emit, bundler-style checking with unused
  and unreachable diagnostics. Library declaration checking is off — Drizzle's
  optional cross-dialect declarations fail here; app source stays checked.
  Re-enable after an upstream fix.
- `eslint.config.ts` uses type-aware strict/stylistic `typescript-eslint`
  presets, imports `.gitignore`, bans non-const assertions, enforces exhaustive
  switches and canonical named imports (one declaration per module with inline
  `type` markers). Default imports: only `@eslint/js`, `@tailwindcss/vite`,
  `vite-plugin-solid`; aliases, namespaces, dynamic imports, import attributes,
  import-equals, `import()` types, side-effect imports (except
  production/browser-test `solid/styles.css`) are rejected. First-party code
  rejects unsafe DOM HTML injection, `dangerouslySetInnerHTML`, HTML-like
  `Response` bodies; HTML-like data, TSX pass.
- Knip checks every issue type and entry export in separate test/production
  graphs; shipped browser scripts are production roots, tests can't keep
  production alive, unused test helpers fail. Add Knip roots for
  runtime/standalone entries; exclude tests from production.
- CPD maps all JS/TS extensions to TSX and ignores imports; its parse-error path
  matches native CPD's crude whole-file fallback tokenizer. Native-token and
  complete-function alpha matches of ≥20 tokens spanning a line boundary fail
  the zero threshold; alpha ignores locally bound names but keeps free names,
  member APIs, literals.
- Repo policy: tracked, unignored files have a 20,000-code-point maximum
  (`bun.lock`, `drizzle/` excepted), tests only under `test`, no app HTML
  outside `test`/`fixtures`.

## Gotchas

- HTTP port 12345 (`PORT` overrides). Google login reads `GOOGLE_CLIENT_ID` and
  `GOOGLE_CLIENT_SECRET` together, plus optional `GOOGLE_REDIRECT_URI`; register
  `http://localhost:12345/api/auth/google/callback` on the OAuth client. Never
  expose the secret to browser code.
- `DATABASE_PATH` selects SQLite (default ignored path `data/q-mush.sqlite`).
  Update `shared/database/schema.ts`, register tables in `databaseSchema`, run
  `bun run db:generate`, and commit the migration and metadata; `db:migrate`
  runs without HTTP. Drizzle Kit runs its config under Node, so never
  transitively import `bun:sqlite` there. Its migration transaction nullifies
  foreign-key PRAGMAs; `createDatabase` therefore disables foreign keys first
  and reenables them afterward.
- Credential storage needs private, stable, 32-byte base64url `*_CREDENTIAL_KEY`
  secrets per provider; redirect URIs end in `/api/<provider>/oauth/callback`.
  OpenAI defaults to the public Codex OAuth client with a localhost-only
  callback at `http://localhost:1455/auth/callback` (keep its port free); a
  different `OPENAI_CLIENT_ID` disables that loopback and must allow the
  configured or request-origin callback. OpenRouter OAuth needs no client
  credentials and yields a user-controlled key. Removal soft-deletes the audit
  record and clears its payload; provider-side access remains.
- `shared/ids.ts` owns UUIDv7 generation and the `SYSTEM` audit actor; user
  actions use the internal user UUID. Never hard-delete: set `isDeleted`,
  `updatedAt`, `updatedById`, excluding soft-deleted rows from active queries.
  Audit actor fields aren't foreign keys — `SYSTEM` is no user.
- Keep HTTP `deflate` zlib-wrapped; Bun's is raw. page_fetch proxy upstream
  connects bound at 10s, under the tool deadline.
- Knip severities don't activate default-off issue types; keep the included list
  complete. Don't run the full test suite alongside lint or repo scans;
  tooling-policy tests probe `solid`.
- Install commands use the request origin: connect other machines through a
  reachable one, not `localhost`. Removal leaves `~/.q-mush/runner`.
- Bun 1.3.14's `Bun.build({ compile: ... })` writes the binary only to
  `compile.outfile` (`outputs[0]` is bundled JS): build in a temp dir, read it
  before cleanup.
- Bare-metal tools accept any runner-account-accessible path; relative paths use
  the workspace. Container file tools and attachment records run on the host and
  stay host-contained. Container shells are disposable per-session root Arch
  (`archlinux:latest` by default), with network/default capabilities and only
  the workspace mounted, so pacman works. `read` pages files. Directory browsing
  escapes the workspace, returns bounded directory-only metadata, times out
  stalls, maps HTTP cancellation to a browse error, and propagates tool
  cancellation. Stopping aborts the model request and runner commands, ending an
  active shell. OpenAI API-key and OAuth requests prefer Responses WebSockets,
  falling back to HTTP streaming; OpenRouter and generic endpoints stream chat
  completions, Anthropic-format ones Messages events. OpenAI OAuth refreshes its
  token bundle before expiry. Sessions need an explicit model ID. Catalogs:
  OpenAI `/v1/models`, OpenRouter `/api/v1/models/user`, ChatGPT Codex
  `/models`, or generic `/models`; Anthropic-format catalogs read
  `display_name`, `max_input_tokens`, `max_tokens`, the `capabilities` tree
  (`agent-model-discovery-anthropic.ts`: effort and adaptive-thinking support
  are independent; modalities come only from `image_input`/`pdf_input` leaves),
  page via `has_more`/`last_id` at `limit=1000` with stale-cursor and page-count
  guards, probing the endpoint's OpenAI-style listing only where capabilities
  left efforts unknown. Codex parsing retains streamed output-text and
  function-call argument deltas since completed events may omit `output`. Only
  listed efforts are offered; OpenAI's catalog lacks reasoning data. Optional
  reasoning uses `reasoning_effort` for OpenAI/generic chat completions and
  `reasoning.effort` for OpenRouter and Codex Responses; Anthropic Messages
  sends `output_config.effort`; unless persisted `adaptiveThinking` is false it
  adds `thinking: {type: "adaptive", display: "summarized"}`. Lazy metadata
  refresh fills null fields independently, never replacing a known capability or
  output limit while learning the other. It sends neither for `none`, maps
  `minimal` to `low`. Adaptive-only models (Fable) ignore `enabled`; newer
  models default `display` to `omitted` — empty thinking text plus a signature
  while thinking tokens bill. The local proxy tolerates tool-loop replay without
  signed thinking blocks; strict endpoints might not. Streamed reasoning deltas
  group by `output_index`/`summary_index`; separate summary parts with
  paragraphs since completed responses may omit them. OpenAI's WebSocket Mode
  has a 60-minute limit; the canonical `websocket_connection_limit_reached` and
  observed underscore-free variant replace the socket once per step, then bound
  retries, replaying only an unpersisted step. Other WebSocket/HTTP
  interruptions or provider errors retry before persistence; replays reset
  partial UI deltas and exhausted WebSockets fall back to HTTP. Permanent errors
  and aborts don't retry; terminal failures persist as non-replayed `error`
  messages.
- Tools persist user settings (`tool-settings*.ts`), defaulting to 30 minutes
  and 20,000 Unicode characters. Writes upsert on a partial index whose
  predicate must match the schema. Runs snapshot both settings for the prompt,
  schemas, engine/runner deadline, sleep, skills/session tools, and final
  model-facing result bound; changes apply next run. Loading clears its timer
  and aborts on settlement. `parallel` shares one budget; `ask_questions` waits
  outside it. One truncation path/notice owns model-facing output; positional
  pagination preserves continuation envelopes; input/security/transport bounds
  remain separate. Shell has a runner timer; each POSIX command gets a session
  whose group is signaled on stop/timeout. Write/edit cancellation is
  best-effort after mutation. Outside compaction, provider replay has no
  timeout.
- Pin Playwright 1.62.1/Vitest 4.1.10: probes couple to Playwright `<launching>`
  and Vitest launch.
