# AGENTS.md

TS Bun/Solid; tests `test/`; `/`, `/app`.

## Working Agreements

- Call capabilities impossible only with excluding evidence; otherwise record an
  open question. Research provider docs via Brave, probe APIs; for tunables
  probe omission, prefer defaults, then metadata/docs.
- Preserve patterns; improve touched code. TDD: fail, implement, refactor green.
  Keep one authoritative path; avoid premature abstraction.
- Fix defects on sight, even pre-existing/out-of-scope ones; if harmful, codify
  why in a test. Integrate every session capability with each protocol's native
  control, recording gaps.
- Never weaken checks or claim unperformed verification; disclose gaps. Record
  decisions/lessons here; repeated guidance means a missing rule. If evidence
  overturns a finding, fix code and stale records; act, don't ask. Never commit
  secrets, artifacts, or env files.
- Keep workflows local-first: narrow checks, then broad, then failures.

## Setup, Commands

- Install/run: `bun install`; `bun run sync-engine/index.ts`. Dev: `bun run dev`
  (`dev:restart`, `dev:watch`); build: `bun run build`; migrations:
  `db:generate` / `db:migrate`.
- Tests: `bun run test`; `test:watch` omits browsers; `test:browser` uses bare
  `scripts/test-browser.ts` (Bun no-orphans rejects `./`/absolute paths), pins
  headless, clears `PWDEBUG`.
- `bun run check` runs static checks; `format`/`lint:fix` write. CI runs tests,
  checks, build, whitespace on Bun 1.3.14 with frozen lockfile.

## Architecture

- Workspaces: solid UI, sync-engine server/integrations, runner, and shared.
  Each imports only itself/`shared`; `shared` imports none; only `scripts` may
  import `scripts`.
- `server.ts` serves Vite's in-memory browser JS/Tailwind CSS. Auth WebSockets
  at `/api/realtime` and `/api/runner/realtime` handle browser/runner state; no
  polling/SSE. `dev:watch` coalesces source/`.env` changes into the ignored
  restart trigger; `dev:restart` writes it, plain `dev` reacts only to it.
  `runner-executable.ts` caches source/compiler fingerprinted builds at
  `/runner/executable`. Restarts drain active steps and queue work, so sessions
  may request their own restart. Text handlers precompress via
  zstd/Brotli/gzip/deflate; `/favicon.svg` revalidates by ETag.
- `solid/pages.tsx` SSR-renders shells; `sync-engine/pages.ts` loads it with
  Vite SSR. App mounts at `solid/client.tsx`; routes in `shared/routes.ts`.
  Browser tests use real Chromium/Tailwind and real mutations, not synthetic
  layout/CSS assertions; CI rejects `.only`/zero tests.
- `sync-engine/auth.ts` does Google OIDC (code + PKCE) with HttpOnly
  state/verifier cookies; it fetches/discards provider tokens. `auth-store.ts`
  uses Bun SQLite/Drizzle, upserting users, persisting 7-day sessions. Keys are
  UUIDv7; Google subjects/session tokens are distinct unique fields; tables have
  created/updated times, actor IDs, `isDeleted`. `shared/database.ts` applies
  migrations on open; `sync-engine/index.ts` injects it; auth falls back to
  in-memory SQLite. Shared PKCE/provider parsing/redirects live in `oauth.ts`;
  cookie helpers in `http.ts`. Client reads `/api/auth/session`, gates app, logs
  out.
- `sync-engine/runner-store.ts` persists runner registrations in `runners`: one
  active registration per machine fingerprint, one default per user.
  `runners.ts` issues hashed tokens, owns management and token-auth callbacks
  and origin-based installers. `runner-installer.ts` emits the macOS/Linux
  one-liner, picking an x64/ARM64 glibc/musl target, starting under
  `~/.q-mush/runner` without Bun. Runners send metadata and 15-second WebSocket
  heartbeats, check updates at startup/5-minute intervals, recheck via handshake
  version after restarts, replacing the old socket on reconnect. Updates use
  source/compiler ETags and SHA-256, atomically replace/restart it; dev restarts
  drain sessions first. Reinstalling for the same user/machine rotates the
  registration to its new token rather than adding one; others stay protected;
  tokens never list.
- Browser messages sort by time then ID; live output anchors at its initiator,
  snapshots replace it. `session-agent-read.ts` keeps positional record/category
  controls; the shared Unicode result bound applies after serialization.
- `sync-engine/sessions.ts` and `session-store.ts` persist coding sessions.
  Messages take eight 10 MB PNG/JPEG/GIF/WebP images. Sessions record active
  time, cost, token usage, context limit; reported charges win. Auto-compaction
  defaults on at 95%; truncation enters only its immediate compactor context,
  including persisted manual/idle compaction, so partial output stays unfinished
  without a retry mark. Idle sessions compact manually or, opted in, at 30 idle
  minutes; compaction soft-deletes messages into a replayable handoff; replays
  deliver drafts, skip re-verifying. Composer stays mounted across statuses,
  explaining unavailable actions, keeping drafts; draft fields echo a local
  signal debounced into the shared draft — submit paths flush first; local prefs
  filter transcript categories. Provider secrets never reach browser/runner
  payloads. Directory picker opens `directory-picker-client.tsx`
  (`/api/runners/:id/directories`). Each run, `read_agent_file` loads root
  `AGENTS.md` (else `CLAUDE.md`).

  `runner/runner-workspace.ts` owns canonical workspace and tool path
  resolution. Tool, skill, model, and effort choices persist per session;
  pickers use schemas. `read_session` spans transcript categories and
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
  user's default across providers. Shared: `provider-credentials.ts`,
  `connected-account-oauth.ts`, the `solid/provider-*` client modules.
- Measure cache hits against the cacheable prefix (total input dilutes with
  fresh tool output); persistent shortfalls are bugs, lone misses noise. Codex
  sockets stay open per run (cache-neutral), reconnect on failure, close at end.
  UI rates divide by summed input minus the final request (summary) or prior
  step's input (per step), clamped at 100%, counting fully reported steps.
  OpenAI/Codex requests carry the session ID as `prompt_cache_key` and the Codex
  `session_id` header (cache routing); that surface rejects
  `prompt_cache_breakpoint`/`prompt_cache_retention`. OpenRouter and
  Anthropic-format requests mark 1-hour `cache_control` points on the system
  prompt, transcript tail, and Anthropic tool definitions
  (`provider-prompt-cache.ts`); OpenAI rejects markers, generic OpenAI-format
  endpoints get neither markers nor `prompt_cache_key` (Ollama rejects array
  content; strict servers reject unknown fields). Requests send catalog
  `max_tokens` (`agent_sessions.max_output_tokens`), omitted when discovery
  reported none — the API requires it, proxies don't; the
  context-window-exceeded beta degrades pre-4.5 overshoots to a stop reason.
  Length stops persist a nonreplayed `error` notice
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
  (`bun.lock`, `drizzle/` excepted); tests live only in `test`; app HTML only in
  `test`/`fixtures`. `AGENTS.md` is at the cap: diff edits/merges against the
  prior blob; re-condense or split at a real seam, never silently evict facts.

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
- Credential storage needs stable 32-byte base64url `*_CREDENTIAL_KEY` secrets
  per provider; redirect URIs end in `/api/<provider>/oauth/callback`. OpenAI
  defaults to the public Codex OAuth client with a localhost-only callback at
  `http://localhost:1455/auth/callback` (keep its port free); a different
  `OPENAI_CLIENT_ID` disables that loopback and must allow the configured or
  request-origin callback. OpenRouter OAuth needs no client credentials and
  yields a user-owned key. Removal soft-deletes the audit record and clears its
  payload; provider-side access remains.
- `shared/ids.ts` owns UUIDv7 generation and the `SYSTEM` audit actor; user
  actions use the internal user UUID. Never hard-delete: set `isDeleted`,
  `updatedAt`, `updatedById`, excluding deleted rows from active queries. Audit
  actor fields aren't foreign keys — `SYSTEM` is no user.
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
  escapes the workspace, returns bounded directory-only metadata, times out at
  15s, maps HTTP cancellation to a browse error, and propagates tool
  cancellation. Stopping aborts the model request and runner commands, ending an
  active shell. OpenAI API-key and OAuth requests prefer Responses WebSockets,
  falling back to HTTP streaming; OpenRouter and generic endpoints stream chat
  completions, Anthropic-format ones Messages events. OpenAI OAuth refreshes its
  token before expiry. Sessions need an explicit model ID. Catalogs: OpenAI
  `/v1/models`, OpenRouter `/api/v1/models/user`, ChatGPT Codex `/models`, or
  generic `/models`; Anthropic-format catalogs read `display_name`,
  `max_input_tokens`, `max_tokens`, the `capabilities` tree
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
  paragraphs since completed responses may omit them. Frozen clocks can collapse
  admission transitions; production cannot. Fresh sockets admit non-retained
  `response.*`; reused ones require an ID or `response.created`. WebSocket Mode
  expires at 60 minutes; either spelling of `websocket_connection_limit_reached`
  replaces the socket once per step, then retries replay only the unpersisted
  step. HTTP waits are not admission-bounded. Discard mismatched-ID/retained-ID
  frames and errors. A reused socket's uncorrelated pre-admission error retries
  fresh unless permanent; after any admission (including ID-less), an
  unidentified error retires it and retries fresh. Provider IDs (~53 bytes) are
  unbounded: fence at 16 MiB, then retire. ID-less admission skips retained IDs
  until a new one; completion retires it. Concurrency closes superseded sockets;
  fenced watchdog failures abort. Requests unacknowledged through the 5-minute
  liveness grace fail without retry, resumable by `continue`. Other
  WebSocket/accepted-HTTP interruptions or provider errors retry before
  persistence; replays reset partial UI deltas; exhausted sockets use HTTP.
  Permanent errors/aborts never retry; terminal failures persist as nonreplayed
  `error`.
- Tools persist user settings (`tool-settings*.ts`), defaulting to 30 minutes
  and 20,000 Unicode characters. Writes upsert on a partial index whose
  predicate must match the schema. Runs snapshot both settings for the prompt,
  schemas, engine/runner deadline, sleep, skills/session tools, and final
  model-facing result bound; changes apply next run. Loading clears its timer
  and aborts on settlement. `parallel` shares one budget; `ask_questions` waits
  outside it. One truncation path/notice owns model-facing output; positional
  pagination preserves continuation envelopes; input/security/transport bounds
  remain separate. Shell commands need a positive timeout; each POSIX command
  gets a session whose group is signaled on stop/timeout. Write/edit
  cancellation is best-effort after mutation. Outside compaction, provider
  replay has no timeout.
- Pin Playwright 1.62.1/Vitest 4.1.10: probes couple to Playwright `<launching>`
  and Vitest launch.
