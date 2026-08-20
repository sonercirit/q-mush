# AGENTS.md

Project memory. Strict TypeScript ESM Bun/SolidJS; tests under `test/`. `/` is
home, `/app` the app.

## Working Agreements

- Research provider docs/trackers online, then probe APIs/schemas. Call a
  capability impossible only with excluding evidence; else record an open
  question.
- Preserve patterns; improve touched code, tests, docs, performance, security,
  DX. TDD: fail first, implement, refactor green. DRY/KISS, one path, no
  premature abstraction.
- Never invent tunables: probe omission, prefer provider defaults, else metadata
  or docs. Integrate once: wire each capability to every protocol's native
  control, noting gaps.
- No reward hacking: never weaken tests, special-case checks, or claim unrun
  checks; disclose unverified work. Fix defects on sight, including
  pre-existing; if a fix is harmful, codify why in a test.
- Record new decisions, gotchas, lessons here in the same change, unprompted — a
  repeated instruction means a missing rule; condense elsewhere to fit the cap.
  When evidence overturns a finding, fix the code it justified and every stale
  record in that change; act, don't ask.
- Keep workflows local-first: narrow checks per change, broad suites once, then
  rerun the narrowest failure. Never commit secrets, artifacts, or env files.

## Setup, Commands

- Install/run `bun install`; `bun run sync-engine/index.ts`. Develop/build:
  `bun run dev` (+ `dev:restart`, `dev:watch`) / `build`; migrations
  `db:generate` / `db:migrate`.
- Test: `bun run test` (Vitest DOM/server + Chromium) / `test:watch`;
  `test:browser` runs Chromium alone. Bun 1.3.14's `--no-orphans` fails for `./`
  or absolute script paths, so keep its path bare; it pins headless,
  `PWDEBUG=0`. Playwright 1.62.1/Vitest 4.1.10 stay pinned: probes couple to
  Playwright's `<launching>` output and Vitest launch.
- `bun run check` runs every static check, each standalone too; `format` /
  `lint:fix` write fixes. CI (`.github/workflows/checks.yml`): tests, static
  checks, build, whitespace on Bun 1.3.14, frozen lockfile.

## Architecture

- Four enforced production workspaces: `solid` owns browser UI, `sync-engine`
  the Bun server/integrations, `runner` the runner, `shared` shared code. The
  first three import only themselves and `shared`; `shared` imports none; only
  `scripts` may import `scripts`.
- `server.ts` serves Vite's in-memory browser JS/Tailwind CSS. Authenticated
  WebSockets `/api/realtime` and `/api/runner/realtime` carry browser state and
  runner work; no polling/SSE. `dev:watch` watches production source and `.env`,
  coalescing bursts into the ignored restart trigger; `dev:restart` writes it,
  plain `dev` restarts from it. `runner-executable.ts` fingerprints runner
  source/compiler, builds privately, caches in memory, serves
  `/runner/executable`. Restarts drain active steps and queue new work, so
  sessions may request one. Text handlers precompress once, negotiating zstd,
  Brotli, gzip, deflate; `/favicon.svg` uses ETag.
- `solid/pages.tsx` renders both page shells via Solid's SSR runtime;
  `sync-engine/pages.ts` loads it with Vite's SSR runner. The app mounts from
  `solid/client.tsx`; routes live in `shared/routes.ts`.
- `sync-engine/auth.ts` implements Google OpenID Connect (code + PKCE) with
  HttpOnly state/verifier cookies, fetching the profile, discarding provider
  tokens. `sync-engine/auth-store.ts` upserts users and persists seven-day
  sessions via Drizzle/Bun SQLite. Primary keys are UUIDv7; Google subjects and
  session cookie tokens are separate unique fields; every table has
  created/updated timestamps, actor IDs, `isDeleted`. `shared/database.ts`
  applies committed `drizzle/` migrations on open; `sync-engine/index.ts`
  injects the persistent connection; the auth factory falls back to in-memory
  SQLite. Shared PKCE, provider parsing, redirects live in `oauth.ts`;
  cookie/response helpers in `http.ts`. `solid/client.tsx` reads
  `/api/auth/session`, gates the app, posts logout. Browser regressions use real
  Chromium/Tailwind and production state/UI mutations, never synthetic layout or
  CSS-only checks; CI rejects `.only`/no tests.
- `sync-engine/runner-store.ts` persists registrations in `runners`: one active
  per machine fingerprint, one default per user. `sync-engine/runners.ts` issues
  hashed opaque setup tokens, owns authenticated management and token callbacks,
  deriving installer commands from the request origin.
  `sync-engine/runner-installer.ts` emits the macOS/Linux one-liner: it picks an
  x64/ARM64 glibc/musl target, starting the downloaded executable in
  `~/.q-mush/runner`; no Bun. Runners report metadata and 15-second heartbeats
  over authenticated WebSockets, check updates at startup/five-minute intervals,
  recheck by handshake version after restarts, replacing older sockets on
  reconnect. Updates use source/compiler ETags and SHA-256, atomically replacing
  and restarting the executable; development restarts drain sessions first.
  Reinstalling for the same user/machine rotates the registration to a new token
  instead of adding a runner; others stay protected; tokens never list.
- Browser messages sort by time then ID; live output anchors at its initiator,
  snapshots replace it. `session-agent-read.ts` keeps positional record/category
  controls; the shared Unicode bound applies post-serialization.
- `sync-engine/sessions.ts` and `session-store.ts` persist sessions. Messages
  take eight 10 MB PNG/JPEG/GIF/WebP images as multimodal input. Sessions record
  active time, cost, tokens, context limit; reported charges win.
  Auto-compaction defaults on at 95%; truncation enters only its immediate
  compactor context, including persisted manual/idle compaction, so partial
  output stays unfinished, unmarked for retry. Idle sessions compact manually
  or, opted in, at 30 idle minutes; compaction soft-deletes messages into a
  replayable handoff; replays deliver drafts, no re-verify. The composer stays
  mounted across statuses, explaining unavailable actions, keeping drafts; draft
  fields echo a local signal debounced into the shared draft — submit paths
  flush first; prefs filter categories. Provider secrets never reach browser or
  runner payloads. The directory field opens `solid/directory-picker-client.tsx`
  (`/api/runners/:id/directories`). Each run `read_agent_file` loads root
  `AGENTS.md` (else `CLAUDE.md`).

  `runner/runner-workspace.ts` owns canonical workspace/tool paths. Session
  tool, skill, model, effort choices persist with canonical schemas.
  `read_session` spans selected transcript categories/definitions by positional
  pagination; `get_session_options` pages spawn choices. Grouped tools manage
  non-blocking children, report finals, resume idle parents; `parallel` takes 2+
  calls on four ordered workers, propagating cancellation.
  `solid/session-transcript.tsx` renders prompts, definitions, raw details,
  Markdown, code/JSON, diffs, results, keeping line breaks; lists page by ten.
  Live sessions use `solid/realtime-client.ts`, `solid/session-client.tsx`,
  `solid/session-controller.ts`: model deltas combine once per frame per
  session, other events immediate, unchanged snapshots suppress notifications,
  keyed messages rerender only changes. The long-lived Solid root preserves
  focus/scroll; session detail is no scroll anchor; only bottom-pinned
  transcripts follow live output. `agent-model-discovery.ts` queries metadata
  cancelably; `shared/agent-configuration.ts` owns catalog types. New sessions
  take the default online runner (else first), credential, first model, last
  directory, top effort. Unknown modalities mean no attachments; choices show
  provider/Q Mush ones. `solid/custom-select.tsx` shares search normalization,
  paginates past ten, owns keyboard/focus. Focus mode fills the app viewport
  (not Fullscreen), keeping drafts/scroll; its rail overlays on desktop, becomes
  a drawer, collapses on selection, closes on Escape. `shared/agent-prompt.ts`
  builds the model system prompt and transcript display; reasoning summaries
  persist as `thinking`, omitted from replay. Rows sit in
  `agent_sessions`/`agent_messages`; `step_started_at` sets per model step,
  clearing with `activeStartedAt` (Step timer); interrupted processes mark
  active sessions failed for resumption; rebuilds add interrupted tool errors.
  While running, server-derived `runtimePending` is `startup`, `runner_command`,
  `engine_tool`, `provider_request`, or `provider_admission`; the codec rejects
  others; the UI shows it.

- `openai.ts`, `openrouter.ts`, `generic-provider.ts` implement model
  connections. Generic providers store a normalized base URL, optional key, and
  an `apiFormat` toggle: the default OpenAI format uses `/models` plus streamed
  `/chat/completions`; Anthropic sends `x-api-key`/`anthropic-version` to
  `/models` and streamed `/messages` (`anthropic-request.ts`,
  `provider-stream-anthropic.ts`; images/PDFs map to native blocks). Credentials
  live in `provider_credentials` with per-record AES-256-GCM encryption; APIs
  expose metadata only; one may be the user's default across providers. Shared:
  `provider-credentials.ts`, `connected-account-oauth.ts`, `provider-*` clients.
- Cache hits use the cacheable prefix; total input dilutes with fresh tool
  output. Persistent shortfalls are bugs; lone misses are late-write/128-token
  noise. Codex sockets persist per run (cache-neutral), reconnect on failure,
  close. UI rates divide summed input minus the final request (summary) or prior
  step input (per step), clamp at 100%, counting only fully reported steps.
  OpenAI/Codex requests carry the session ID as `prompt_cache_key` and the Codex
  `session_id` header (routing); that rejects
  `prompt_cache_breakpoint`/`prompt_cache_retention`. OpenRouter and
  Anthropic-format requests mark one-hour `cache_control` breakpoints on the
  system prompt, transcript tail, tool definitions (`provider-prompt-cache.ts`);
  OpenAI rejects markers; generic OpenAI-format endpoints get neither markers
  nor `prompt_cache_key` (Ollama rejects array content; strict servers reject
  unknown fields). Messages requests send catalog `max_tokens`
  (`agent_sessions.max_output_tokens`), omitted when discovery reported none —
  the real API requires it, proxies don't; the context-window-exceeded beta
  degrades pre-4.5 overshoots to a stop. Length stops persist a non-replayed
  `error` truncation notice (`AgentModelStep.truncation`). Null limits refresh
  lazily (`session-current-model.ts`) only while the credential stays attached,
  propagating stops, not degrading; generic reassignment nulls limits to
  re-probe; else they snapshot like context limits.
- `sync-engine/brave-search.ts` implements the server-side `brave_search` skill
  and key API. Users keep encrypted keys in `provider_credentials`; failures
  fall through in creation order; secrets never reach browser, runner, or
  provider.
- `solid/client.tsx` is the browser entry; `solid/pages.tsx` owns SSR shells;
  `solid/styles.css` is Tailwind's source. Vitest uses an SSR Solid transform
  for strings and a Happy DOM project for post-mount reactivity; run under Bun —
  tests/app modules use Bun APIs and `bun:sqlite`. Fixtures stub discovery;
  tests never hit live providers.
- `tsconfig.json` configures strict, no-emit, bundler-style checking with
  unused/unreachable diagnostics. Library declaration checking is off — Drizzle
  publishes optional cross-dialect declarations that fail here; app source stays
  checked; re-enable after an upstream fix.
- `eslint.config.ts` uses type-aware strict/stylistic `typescript-eslint`
  presets, imports `.gitignore`, bans non-const assertions, enforces exhaustive
  switches and canonical named imports (one declaration per module, inline
  `type` markers). Default imports: only `@eslint/js`, `@tailwindcss/vite`,
  `vite-plugin-solid`; aliases, namespaces, dynamic imports, import attributes,
  import-equals, `import()` types, side-effect imports (except
  production/browser-test `solid/styles.css`) are rejected. First-party code
  rejects unsafe DOM HTML injection, `dangerouslySetInnerHTML`, HTML-like
  `Response` bodies; HTML-like data and TSX pass.
- Knip checks every issue type and entry export in test/production graphs; tests
  cannot keep production alive; unused helpers fail.
- CPD maps all JS/TS extensions to TSX, ignoring imports. Its parse-error path
  matches native CPD's crude whole-file fallback tokenizer. Native-token and
  complete-function alpha matches of ≥20 tokens crossing a line boundary fail
  the zero threshold; alpha ignores local names, keeping free names, member
  APIs, literals.
- Repository policy scans tracked, unignored files: 20,000-code-point cap
  (`bun.lock`, `drizzle/` excepted), tests only under `test`, no app HTML
  outside `test`/`fixtures`.

## Gotchas

- HTTP port 12345 (`PORT` overrides). Google login reads `GOOGLE_CLIENT_ID`,
  `GOOGLE_CLIENT_SECRET`, optional `GOOGLE_REDIRECT_URI`; the two appear
  together; register `http://localhost:12345/api/auth/google/callback` on the
  OAuth client. Never expose the secret to browsers.
- `DATABASE_PATH` selects SQLite (default `data/q-mush.sqlite`; `data/`
  ignored). Update `shared/database/schema.ts`, register tables in
  `databaseSchema`, `db:generate`, commit migration and metadata; `db:migrate`
  runs without HTTP. Drizzle Kit runs its config under Node; never transitively
  import `bun:sqlite` there. Drizzle's migration transaction nullifies
  foreign-key PRAGMAs, so `createDatabase` disables them first, reenabling
  after.
- Credential storage needs stable, private, 32-byte base64url `*_CREDENTIAL_KEY`
  secrets per provider; redirect URIs end `/api/<provider>/oauth/callback`.
  OpenAI defaults to the Codex public OAuth client with a localhost-only
  callback on its registered `http://localhost:1455/auth/callback` (keep the
  port free); a differing `OPENAI_CLIENT_ID` disables the loopback and must
  allow the configured or request-origin callback. OpenRouter OAuth needs no
  client credentials, yielding a user key. Removal soft-deletes the audit
  record, clearing the payload; provider access stays.
- `shared/ids.ts` owns UUIDv7 generation and the `SYSTEM` audit actor; user
  actions use the internal user UUID. Never hard-delete: set `isDeleted`,
  `updatedAt`, `updatedById`, excluding soft-deleted rows from active queries.
  Audit actor fields are not foreign keys — `SYSTEM` is no user row.
- Keep HTTP `deflate` zlib-wrapped; Bun's is raw. page_fetch proxy upstream
  connects bound at 10s, under the tool deadline.
- Knip severities alone do not enable default-off issue types; keep the included
  list complete. Never run the full suite parallel to lint or scans; tooling
  tests probe `solid`.
- Runner install commands use the HTTP request origin: connect machines through
  a reachable origin, not `localhost`. Removal leaves `~/.q-mush/runner`.
- Bun 1.3.14's `Bun.build({ compile: ... })` writes the binary only to
  `compile.outfile` (`outputs[0]` is bundled JS): build in a temp directory,
  reading the outfile before cleanup.
- Bare-metal file tools resolve relative paths against the runner workspace but
  take any runner-accessible path; container file tools and attachment records
  stay contained (running on the host). Container shells run as root in a
  disposable per-session Arch container (default `archlinux:latest`) with
  network/default capabilities, so pacman works; only the workspace mounts.
  `read` pages source. The directory picker uses runner permissions beyond
  workspaces, returns bounded directory-only results, times out at 15s, maps
  HTTP cancellation to a browse error, propagates tool cancellation. Stopping
  aborts model requests and runner commands, ending shells.
- OpenAI API-key and OAuth requests prefer Responses WebSockets, falling back to
  HTTP streaming; OpenRouter/generic endpoints stream chat, Anthropic-format
  Messages events. OpenAI OAuth refreshes its token bundle before expiry.
  Session creation needs an explicit model ID. Catalogs: OpenAI `/v1/models`,
  OpenRouter `/api/v1/models/user`, Codex `/models`, generic `/models`;
  Anthropic-format catalogs read `display_name`, `max_input_tokens`,
  `max_tokens`, `capabilities` (`agent-model-discovery-anthropic.ts`: effort and
  adaptive-thinking support are independent; modalities come only from
  `image_input`/`pdf_input` leaves), page by `has_more`/`last_id` at
  `limit=1000` with stale-cursor/page-count guards, probing OpenAI-style listing
  only where capabilities leave efforts unknown. Codex parsing keeps streamed
  output-text and function-call argument deltas since completed events may omit
  `output`. Only listed efforts are offered; OpenAI's catalog lacks reasoning.
  Reasoning uses `reasoning_effort` for OpenAI/generic chat, `reasoning.effort`
  for OpenRouter/Codex Responses; Anthropic Messages sends
  `output_config.effort`; unless persisted `adaptiveThinking` is false it adds
  `thinking: {type: "adaptive", display: "summarized"}`. Lazy metadata refresh
  fills null fields independently, never replacing a known capability or output
  limit while learning the other. It sends neither for `none`; `minimal` maps to
  `low`. Adaptive-only models (Fable) ignore `enabled`; newer models default
  `display` to `omitted` — empty thinking text plus a signature while thinking
  tokens bill. The local proxy tolerates tool-loop replay without signed
  thinking blocks; strict endpoints may not. Streamed reasoning deltas group by
  `output_index`/`summary_index`; separate summary parts with paragraphs since
  completed responses may omit them.
- Frozen clocks may collapse admission transitions; production cannot. A fresh
  socket admits any non-retained `response.*`; a reused one needs an ID or
  `response.created`. WebSocket Mode expires in 60 minutes; the canonical
  `websocket_connection_limit_reached` and observed underscore-free variant
  replace the socket once per step, then retries replay an unpersisted step.
  HTTP waits are not admission-bounded. Discard mismatched-ID and retained-ID
  frames/errors. On a reused socket, an uncorrelated pre-admission error retries
  fresh unless permanent, which surfaces; after admission, including ID-less, an
  unidentified error retires it, retrying fresh. Provider IDs (~53 bytes) are
  unbounded; fence at 16 MiB, then retire. ID-less admission skips retained IDs
  until a new one; completion retires it. Concurrency closes superseded sockets;
  fenced watchdog failures abort. Requests unacknowledged through the
  five-minute liveness grace fail without retry, staying resumable by
  `continue`. Other WebSocket/accepted HTTP interruptions or provider errors
  retry before persistence; replays reset partial UI deltas; exhausted sockets
  use HTTP. Permanent errors and aborts never retry; terminal failures persist
  as non-replayed `error`.
- Tools use persisted user settings, defaulting to 30 minutes and 20,000 Unicode
  characters. Writes upsert on the partial index; keep its conflict predicate
  schema-aligned. Each run snapshots both for its prompt, schemas, engine/runner
  deadline, sleep, skills/session tools, final model-facing bound; changes apply
  next run; realtime updates stay user-scoped. Loading clears its timer,
  aborting its signal on settlement. `parallel` shares one budget;
  `ask_questions` waits outside it. One truncation path/notice owns model-facing
  output; positional pagination keeps valid continuation envelopes;
  input/security/transport bounds stay apart. Shell commands need a positive
  timeout and a runner timer; each POSIX command gets a session, stop/timeout
  signaling only its group. Write/edit cancellation is best-effort
  post-mutation; outside compaction providers replay untimed.
- Add runtime roots and standalone build entries to matching Knip configs;
  exclude test support from production patterns.
