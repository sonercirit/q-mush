# AGENTS.md

Memory.

## Project Snapshot

- Strict TypeScript ESM Bun/SolidJS; tests live under `test/`, no `src`. `/` is
  the homepage, `/app` the app.

## Working Agreements

- Call capabilities impossible only with excluding evidence; else record an open
  question. Research provider docs via Brave and probe APIs; omit tunables
  first, then prefer defaults and metadata/docs.
- Preserve patterns; improve touched code. TDD: fail, implement, refactor green.
  Keep one path; avoid premature abstraction.
- Fix defects on sight, including pre-existing/out-of-scope; if harmful, codify
  why in a test. Integrate each session capability with every protocol's native
  control, recording gaps.
- Never weaken checks or claim unperformed verification; disclose gaps. Record
  decisions/lessons in the appropriate memory file: facts about provider
  discovery, requests, streaming, caching, retries, or model capability handling
  belong in `PROVIDER_PROTOCOLS.md`; everything else, including provider
  credential and OAuth configuration, stays here. Repeated guidance means a
  missing rule. If evidence overturns a finding, fix code and stale records;
  act, don't ask. Never commit secrets, artifacts, or env files.
- Keep workflows local-first: narrow checks, then broad, then failures.

## Setup, Commands

- Install/run: `bun install`; `bun run sync-engine/index.ts`. Dev: `bun run dev`
  (`dev:restart`, `dev:watch`); build: `bun run build`; migrations:
  `db:generate` / `db:migrate`.
- Tests: `bun run test`; `test:watch` omits browsers; `test:browser` uses bare
  `scripts/test-browser.ts` (Bun no-orphans rejects `./`/absolute paths), pins
  headless, clears `PWDEBUG`. `.github/workflows/checks.yml` runs CI.
- `bun run check` runs static checks; `format`/`lint:fix` write. CI runs tests,
  checks, build, whitespace on Bun 1.3.14 with frozen lockfile.

## Architecture

- Workspaces: solid UI, sync-engine server/integrations, runner, shared; each
  imports only itself/`shared`; `shared` imports none; only `scripts` imports
  `scripts`.
- `server.ts` serves Vite's in-memory browser JS/Tailwind CSS. Auth WebSockets
  at `/api/realtime` and `/api/runner/realtime` handle browser/runner state; no
  polling/SSE. `dev:watch` coalesces source/`.env` changes into the ignored
  restart trigger; `dev:restart` writes it, plain `dev` reacts only to it.
  `runner-executable.ts` caches source/compiler-fingerprinted builds at
  `/runner/executable`. Restarts drain active steps and queue work, so sessions
  may request their own restart. `DevelopmentRestartLifecycle` bounds a dev
  restart with one shared 120s supervisor deadline, rejects new work, reports
  scoped active-tool counts, force-parks stragglers only after durable handoffs,
  bounds cleanup with purpose-named, identity-bearing restart timers, and
  escalates repeats. A rejected drain restores maintenance, shutdown state,
  recovery, its gate and abort signal; requests capture one
  `SessionRestartAbort` signal identity across awaits, and aborted controllers
  remain aborted through recovery. It clears each session's abandoned server
  request (still-gating runner requests stay), then reruns handoff recovery and
  the queued launcher unless shutdown won. Final shutdown cancels the lifecycle,
  promotes runner handoffs to server markers and fences live markers from
  liveness scans. Text handlers precompress with zstd/Brotli/gzip/deflate;
  `/favicon.svg` revalidates by ETag.
- `solid/pages.tsx` SSR-renders shells; `sync-engine/pages.ts` loads it with
  Vite SSR. App mounts at `solid/client.tsx`; routes in `shared/routes.ts`.
  Browser tests use real Chromium/Tailwind mutations, not synthetic layout/CSS
  assertions; CI rejects `.only`/zero tests.
- `sync-engine/auth.ts` does Google OIDC (code + PKCE) with HttpOnly
  state/verifier cookies; it fetches/discards provider tokens.
  `sync-engine/auth-store.ts` uses Bun SQLite/Drizzle to upsert users and
  persist 7-day sessions. Keys are UUIDv7; Google subjects/session tokens are
  distinct unique fields; tables have created/updated timestamps, actor IDs,
  `isDeleted`. `shared/database.ts` applies migrations on open;
  `sync-engine/index.ts` injects it; auth falls back to in-memory SQLite. Shared
  PKCE/provider parsing/redirects are in `oauth.ts`; cookie helpers in
  `http.ts`. Client reads `/api/auth/session`, gates app, logs out.
- `sync-engine/runner-store.ts` persists runner registrations in `runners`: one
  active registration per machine fingerprint, one default per user.
  `sync-engine/runners.ts` issues hashed opaque setup tokens, owns
  management/token-auth callbacks and origin-based installers.
  `sync-engine/runner-installer.ts` emits the macOS/Linux one-liner: picks an
  x64/ARM64 glibc/musl target, starts under `~/.q-mush/runner` without Bun.
  Runners send metadata and 15-second WebSocket heartbeats, check updates on
  startup/every 5 minutes, recheck via handshake version after restarts,
  replacing old sockets on reconnect. Updates use source/compiler ETags and
  SHA-256, atomically replace/restart; dev restarts drain sessions first.
  Reinstalling for the same user/machine rotates the registration to its new
  token instead of adding one; others stay protected; tokens never list.
- Browser messages sort by time/ID; live output anchors at its initiator,
  snapshots replace it. `session-agent-read.ts` keeps positional record/category
  controls; shared Unicode result bound applies after serialization.
- `sync-engine/sessions.ts` and `session-store.ts` persist coding sessions.
  Session roots and each expanded child group paginate independently, nesting
  every linked child exactly once. The owned detail header shows the stable
  session ID with responsive selectable text and clipboard feedback; public page
  shells contain no session identity. Messages take eight 10 MB
  PNG/JPEG/GIF/WebP images. Sessions record active time, cost, token usage,
  context limit; reported charges win. Auto-compaction defaults on at 95%;
  truncation enters only its immediate compactor context, including persisted
  manual/idle compaction, so partial output stays unfinished without retry
  marking. Idle sessions compact manually or, opted in, at 30 idle minutes;
  compaction soft-deletes messages into a replayable handoff; replays deliver
  drafts, skip re-verifying. Composer stays mounted across statuses, explaining
  unavailable actions, keeping drafts; draft fields echo a local signal
  debounced into the shared draft — submit paths flush first; local prefs filter
  transcript categories. Provider secrets never reach browser/runner payloads.
  Directory picker uses `solid/directory-picker-client.tsx`
  (`/api/runners/:id/directories`). Each run, `read_agent_file` loads root
  `AGENTS.md` (else `CLAUDE.md`).

  `runner/runner-workspace.ts` owns canonical workspace and tool path
  resolution. Tool, skill, model, and effort choices persist per session;
  pickers use schemas. `read_session` spans transcript categories and
  definitions with positional record pagination; `get_session_options` pages
  spawn choices. Native spawns reserve one durable child before provider
  discovery; stable lineage uses `parent_session_id` and
  `parent_execution_generation`, while callbacks consume
  `parent_callback_generation` independently. Startup repairs only unambiguous
  same-user/workspace direct or parallel spawn results and fails unfinished
  reservations. User-initiated children do not create spawn reservations.
  Parent-report tests must exercise the shared emitter and pin every
  administrative caller; generation tests must distinguish attempt advances
  (successor reportable) from administrative advances (successor
  non-reportable), or duplicate/lost delivery mutations can survive. Grouped
  tools manage non-blocking owned children; a generation ledger delivers one
  sanitized terminal event per attempt, including continued/immediate failures.
  Terminal statuses and an idle generation ending in a final assistant response
  report; an input pause or idle generation without a final response does not.
  Routes survive delivery, recreation, compaction, and disconnects; only
  attempts report, administrative fences settle identity without duplicates, and
  callback persistence/claiming are atomic. `callback_pending` blocks another
  attempt; non-runnable parents retain events until resumed. Delivery callbacks
  notify the parent and wake it only when it is idle, has no restart handoff,
  has no active execution, can resume, and its runner is available; failed,
  stopped, paused/queued/running, runner-required, and restart-draining parents
  retain events until explicitly resumed or recovered. `parallel` uses four
  ordered workers for 2+ calls and propagates cancellation.
  `session-transcript.tsx` renders prompts, definitions
  (`session-tool-definitions.tsx`), Markdown, code/JSON, diffs/results,
  preserving user line breaks; lists page by ten. Live streams use four-key
  preparation frames; batches patch once, compacting the oldest or protected
  candidate pre-eviction. `sync_tools` fan-out, pending buffers, keyed snapshots
  stay bounded (`realtime-stream-buffer-limits.ts`); reconnects dedupe resyncs.
  Mutation/stop freezes model/tool UI; settlement rebases streams. Disconnect
  drops unrendered fragments, resyncs paused tools. Every eviction requests
  snapshots: an undelivered terminal can't clear a running row. Barriers and
  100/session, 1,000/user caps block stale revival and key reuse. Epochs stay
  monotonic while updates/barriers are queued; releasing the last barrier
  reclaims its epoch once updates drain. Terminal cleanup can't reset epochs
  with later barriers. Resets replace model state; state events coalesce
  one/frame; ready, health, commands, and user-scoped tool-setting updates apply
  immediately; no-op snapshots suppress notices. Solid preserves focus/scroll;
  detail disables document anchoring, and only bottom-pinned transcripts follow
  output. `agent-model-discovery.ts` queries metadata, signal-cancelable;
  `agent-configuration.ts` owns catalog types/validation. New sessions take
  default online runner (else first) and credential, first discovered model,
  latest directory, top reported effort. Unknown modalities mean no attachment
  support; choices show provider/Q Mush modalities. `custom-select.tsx` shares
  search normalization, paginates past ten items, owns accessible
  keyboard/focus. Focus mode fills app viewport (not browser Fullscreen),
  keeping drafts and scroll; its rail overlays on desktop, is a drawer,
  collapses on selection, closing with Escape first. `agent-prompt.ts` builds
  system prompt and transcript display; reasoning summaries persist as
  `thinking` messages omitted in replay. Session/transcript rows are in
  `agent_sessions` and `agent_messages`; `step_started_at` sets per model step,
  clears with `activeStartedAt` (live Step timer); interrupted processes mark
  active sessions failed, resumable; rebuilds add interrupted tool errors on
  resume. While running, server-derived `runtimePending` is `startup`,
  `runner_command`, `engine_tool`, `provider_request`, or `provider_admission`;
  codec rejects others; the UI shows it.

- OAuth credential reconnects update the existing record only after returned and
  stored account IDs match; unverifiable OpenRouter accounts fail closed.
  Terminal OpenAI refresh rejection marks the credential re-login-required,
  excludes it from balanced pools, and directs the UI to reconnect. API-key
  credentials bypass OAuth recovery.
- Detailed provider/model protocol architecture and operational rules live in
  `PROVIDER_PROTOCOLS.md`; read it before changing provider discovery, requests,
  streaming, caching, retries, or model capability handling.
- `sync-engine/brave-search.ts` implements the authenticated `brave_search`
  skill and key API. Users store encrypted keys in `provider_credentials`;
  failures fall through them in creation order; keys stay server-side.
- `solid/client.tsx` is the browser entry; `pages.tsx` owns SSR shells,
  `styles.css` is Tailwind's source. Vitest uses an SSR Solid transform for
  string rendering and a Happy DOM project for post-mount reactivity; run it
  under Bun — tests/app modules use Bun APIs and `bun:sqlite`. Fixtures stub
  discovery; tests avoid live providers.
- `tsconfig.json` configures strict no-emit bundler-style checks with unused and
  unreachable diagnostics. Library declaration checks are off — Drizzle's
  optional cross-dialect declarations fail here; app source remains checked.
  Re-enable after an upstream fix.
- `eslint.config.ts` uses type-aware strict/stylistic `typescript-eslint`
  presets, imports `.gitignore`, bans non-const assertions and all TypeScript
  `switch` statements/classes (use conditionals/data dispatch and
  functions/plain objects), enforces exhaustive switches and canonical named
  imports (one declaration/module with inline `type` markers). Default imports:
  only `@eslint/js`, `@tailwindcss/vite`, `vite-plugin-solid`; aliases,
  namespaces, dynamic imports, import attributes, import-equals, `import()`
  types, side-effect imports (except production/browser-test `solid/styles.css`)
  are rejected. First-party code rejects unsafe DOM HTML injection,
  `dangerouslySetInnerHTML`, HTML-like `Response` bodies; HTML-like data, TSX
  pass.
- Knip checks all issue types and entry exports in separate test/production
  graphs; shipped browser scripts are production roots, tests can't keep
  production alive, unused test helpers fail. Add Knip roots for
  runtime/standalone entries; exclude tests from production.
- CPD maps all JS/TS extensions to TSX and ignores imports; its parse-error path
  matches native CPD's crude whole-file fallback tokenizer. Native-token and
  complete-function alpha matches of ≥20 tokens crossing lines fail the zero
  threshold; alpha ignores local names but keeps free names, member APIs,
  literals.
- Repo policy: tracked/unignored files have a 20,000-code-point maximum
  (`bun.lock`, `drizzle/` excepted); tests only in `test`; app HTML only in
  `test`/`fixtures`.

## Gotchas

- Neither memory file runs at its cap: `AGENTS.md` and `PROVIDER_PROTOCOLS.md`
  each share a 20,000-code-point cap; diff edits/merges against the pre-merge
  blob, and re-condense or split at a real seam rather than silently evicting
  facts.
- HTTP port 12345 (`PORT` overrides). Google login uses `GOOGLE_CLIENT_ID` and
  `GOOGLE_CLIENT_SECRET` together, plus optional `GOOGLE_REDIRECT_URI`; register
  `http://localhost:12345/api/auth/google/callback` with the OAuth client. Never
  expose the secret to browser code.
- `DATABASE_PATH` selects SQLite (default ignored `data/q-mush.sqlite`). Update
  `shared/database/schema.ts`, register tables with `databaseSchema`, run
  `bun run db:generate`, commit migration and metadata; `db:migrate` runs
  without HTTP. Drizzle Kit runs its config under Node, so never transitively
  import `bun:sqlite` there. Its migration transaction nullifies foreign-key
  PRAGMAs; `createDatabase` disables foreign keys first and reenables them
  afterward.
- Credential storage needs stable 32-byte base64url `*_CREDENTIAL_KEY` secrets
  per provider; OAuth redirect URIs (not merely HTTP redirects) end in
  `/api/<provider>/oauth/callback`. OpenAI defaults to the public Codex OAuth
  client with localhost-only callback at `http://localhost:1455/auth/callback`
  (keep its port free); a different `OPENAI_CLIENT_ID` disables that loopback
  and must allow the configured or request-origin callback. OpenRouter OAuth
  needs no client credentials and yields user-owned keys. Removal soft-deletes
  its audit record and clears its payload; provider-side access remains.
- `shared/ids.ts` owns UUIDv7 generation and the `SYSTEM` audit actor; user
  actions use the internal user UUID. Never hard-delete: set `isDeleted`,
  `updatedAt`, `updatedById`, exclude deleted rows from active queries. Audit
  actor fields aren't foreign keys — `SYSTEM` is no user.
- Keep HTTP `deflate` zlib-wrapped; Bun's is raw. page_fetch proxy upstream
  connects bound at 10s, within the tool deadline.
- Knip severities don't activate default-off issue types; keep the included list
  complete. Don't run the full test suite with lint/repo scans; tooling-policy
  tests probe `solid`.
- Install commands use request origin: connect other machines through a
  reachable one, not `localhost`. Removal leaves `~/.q-mush/runner`.
- Bun 1.3.14's `Bun.build({ compile: ... })` writes the binary only to
  `compile.outfile` (`outputs[0]` is bundled JS): build in temp, read it
  pre-cleanup.
- Bare-metal tools accept any runner-account-accessible path (an
  `account-accessible` path for the runner account); relative paths use the
  workspace. Container file tools/attachments run on the host and stay
  host-contained. Container shells are disposable per-session root Arch
  (`archlinux:latest` by default), with default network/capabilities; only the
  workspace mounted, allowing pacman. `read` pages files. Directory browsing
  escapes the workspace, returns bounded directory-only metadata, times out at
  15s, maps HTTP cancellation to browse errors, and propagates tool
  cancellation. Stopping aborts model requests and runner commands, ending an
  active shell. See `PROVIDER_PROTOCOLS.md` for provider/model transport,
  discovery, reasoning, and retry rules.
- Tools persist user settings (`tool-settings*.ts`), defaulting to 30 minutes
  and 20,000 Unicode characters. Writes upsert on a partial index whose
  predicate must match the schema. Runs snapshot both settings for the prompt,
  schemas, engine/runner deadline, sleep, skills/session tools, and final
  model-facing result bound; changes apply next run. Loading clears its timer
  and aborts on settlement. `parallel` shares one budget; `ask_questions` waits
  outside it. One path/notice owns model-facing truncation; positional
  pagination preserves continuation envelopes; input/security/transport bounds
  remain separate. Shell commands require positive timeouts; each POSIX command
  gets a session whose group is signaled on stop/timeout. Write/edit
  cancellation after mutation is best-effort. Outside compaction, provider
  replay has no timeout.
- Pin Playwright 1.62.1/Vitest 4.1.10: probes couple to Playwright `<launching>`
  and Vitest launch.
