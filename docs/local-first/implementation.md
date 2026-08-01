# Implementation plan, alternatives, and open questions

This document is normative detail for the
[local-first architecture](../local-first-architecture.md). After design
acceptance, create one GitHub issue per stage with the listed exit criteria.
Stages are ordered, independently shippable, and keep compatibility with the
current engine path until the cutover stage.

## Staged implementation

### Stage 1 — Runner-served read-only app and local history

**Standalone value:** a runner contains the app and can open its own replicated
session history after the engine stops. This proves distribution, local serving,
storage, and browser auth without moving execution.

Scope:

- Extract the browser asset build/manifest from `sync-engine/client-build.ts`
  and `sync-engine/server.ts` into build-time modules that can package the same
  `solid/` release for both hosts.
- Extend `sync-engine/runner-executable.ts`, `runner/runner-update.ts`, and
  `runner/runner-agent.ts` so the signed/fingerprinted standalone runner embeds
  and serves the web release on a stable loopback origin.
- Add a private runner SQLite database and migrations. While online, extend the
  existing runner realtime connection with a bounded, read-only session/message
  projection for sessions assigned to that runner. Keep provider credential
  secret fields excluded by construction.
- Add engine-online pairing and a locked runner-local auth page. No reuse of the
  `qmr_` setup token in browser APIs.
- Add a host abstraction in `solid/` so auth/session reads can target an engine
  or runner, plus origin/mode/read-only indicators. Keep existing engine
  behavior unchanged.
- Add release-manifest, cache, exact Host/Origin, CORS, DNS-rebinding, and
  secret canary tests.

Likely workspaces/files: `runner/runner-agent.ts`, new
`runner/runner-server*.ts` and `runner/runner-replica*.ts`;
`sync-engine/client-build.ts`, `sync-engine/runner-executable.ts`,
`sync-engine/realtime*.ts`; `solid/client.tsx`, `solid/browser-http.ts`, new
host/connection UI; `shared/routes.ts`, new shared read-projection/manifest/auth
types; `scripts/` only for build packaging if needed; migration files under
`drizzle/` if the engine tracks runner app metadata.

Exit criteria:

- A standalone executable contains hashed app assets and serves them without
  Bun/source/Vite on the runner machine.
- After one online sync, killing the engine still allows a freshly opened paired
  loopback tab to list/read that runner's assigned sessions and locally present
  attachments.
- All mutations are visibly disabled; no screen implies execution continues.
- Existing install/update/engine UI paths remain compatible.

### Stage 2 — Durable operation core and browser local replica

**Standalone value:** prompt/workspace metadata and drafts respond immediately,
survive reload/offline, and converge through the engine, before P2P execution
exists.

Scope:

- Implement the canonical operation envelope, device sequence/HLC, causal
  frontier, idempotent apply, quarantine, snapshots, checkpoints, and bounded
  anti-entropy in `shared/`.
- Add engine and runner SQLite inbox/outbox/projection tables to
  `shared/database/schema.ts` with generated Drizzle migrations. Add an
  IndexedDB adapter and durable outbox in `solid/`.
- Introduce engine-issued device certificates/workspace grants for existing
  online sessions. Persist browser keys through WebCrypto and runner keys in
  private storage.
- Replicate low-risk entities first: prompt identity/name/body/tombstone,
  workspace display fields/default, and read-only session/history operations
  emitted from current engine stores. Adapt `sync-engine/prompt-store.ts`,
  `sync-engine/workspace-store.ts`, and session recording through one
  transactional operation boundary.
- Add same-origin `BroadcastChannel` coordination and offline/conflict/outbox
  UI.
- Run reproducible Automerge and Yjs spikes in browser, Bun 1.3.14, Vite, and
  each supported standalone compile target. Record an ADR; add no CRDT
  dependency unless it beats the domain operation implementation for an actual
  requirement.

Likely workspaces/files: new `shared/peer-*.ts`, `shared/replication-*.ts`, and
schema tables; `sync-engine/*-store.ts` adapters and peer endpoint;
`solid/discovery-*.ts`, new IndexedDB/operation/transport modules and prompt UI;
`runner/runner-replica*.ts`; tests in each workspace and migration coverage in
`scripts/test/`.

Exit criteria:

- Two profiles can edit supported entities while partitioned and converge
  deterministically after engine-mediated sync.
- Reload never loses a locally acknowledged operation.
- Tombstones do not resurrect, same-name conflicts remain accessible, bad
  signatures/schema/clock jumps are quarantined, and replay is idempotent.
- Browser storage and every peer frame pass secret-canary tests.

### Stage 3 — Direct peer transport and discovery

**Standalone value:** replication and live updates flow directly on loopback/LAN
and between tabs even if the engine data path is stopped.

Scope:

- Implement the shared peer frame protocol over authenticated WebSockets. Runner
  loopback is first; opt-in pinned-TLS LAN endpoints follow.
- Add runner mDNS advertise/browse with opaque metadata, manual URLs/QR pairing,
  cached peer candidates, and engine-distributed signed peer lists while online.
- Add WebRTC data-channel transport for browser peers. Use runner/engine
  signaling, then add manual offer/answer. Add `BroadcastChannel` connection
  ownership for same-origin tabs.
- Add mutual device challenge-response, grant intersection, revocation gossip,
  flow control, operation/blob quotas, and connection diagnostics.
- Make `solid/realtime-client.ts` a transport multiplexer while retaining the
  existing command/snapshot codecs for backward compatibility.

Likely workspaces/files: `shared/user-realtime-protocol.ts`, new shared peer
protocol/crypto types; `runner/runner-server*.ts`, discovery and sync modules;
`sync-engine/realtime*.ts` and peer-directory endpoints;
`solid/realtime-client.ts`, `solid/discovery-*.ts`, new WebRTC/BroadcastChannel
adapters and diagnostics.

Exit criteria:

- With the engine killed after pairing, a runner tab and another reachable peer
  exchange operations and live durable snapshots directly.
- Loopback, LAN, manual URL, same-origin tabs, WebRTC signaling failure, NAT no
  route, revocation, and incompatible protocol states all have tested,
  unambiguous behavior.
- Discovery reveals no user, workspace, path, session, or provider metadata.

### Stage 4 — Runner credential vault and local executor

**Standalone value:** one provisioned runner can create and complete a full
session while the engine is absent.

Scope:

- Extract engine-neutral provider/model/agent loop and persistence domain logic
  from modules such as `sync-engine/agent-model.ts`,
  `sync-engine/session-agent-loop.ts`, and
  `sync-engine/session-agent-runtime.ts` into `shared/`, with engine and runner
  host adapters. Preserve workspace boundaries; never import `sync-engine/` from
  `runner/`.
- Add engine-authorized X25519 credential-envelope provisioning and the private
  runner vault for OpenAI, OpenRouter, generic providers, attachment fallbacks,
  and Brave Search. UI exposes only target availability.
- Run the coordinator on the runner and invoke existing
  `runner/runner-command.ts`, `runner/runner-tools.ts`, workspace containment,
  container, attachment, and page-fetch modules locally instead of through the
  engine's `RunnerCommandBroker` socket.
- Implement epoch-zero authority, executor sequence, durable command receipts,
  write-ahead tool start/finish, local model deltas, and final operation
  publication.
- Route create/continue/follow-up/steer/answer/stop/compact to the authority;
  preserve engine execution for legacy sessions behind a capability flag.

Likely workspaces/files: engine `agent-*`/`session-agent-*` extraction into
narrow `shared/` modules; runner coordinator/vault/storage; engine envelope
endpoints; `solid/session-transport.ts` and availability UI; schemas/migrations.

Exit criteria:

- Kill the engine before and during turns. A provisioned runner creates,
  continues, steers, answers, stops, compacts, and completes sessions with
  durable transcript/usage; same-runner spawn works.
- Provider outage and credential expiry are distinct from engine outage.
- No provider/Brave secret appears in browser memory/API captures, operation or
  blob stores, P2P frames, runner tool commands, bundles, or logs.
- Restart and ambiguous external side-effect tests never blindly duplicate an
  interrupted tool call.

### Stage 5 — Multi-runner authority and graceful handoff

**Standalone value:** reachable runners cooperate directly, and session
assignment has an enforceable single executor rather than relying on the engine
process.

Scope:

- Implement authority certificates, monotonically increasing epochs, graceful
  drain/fence/offer/accept handoff, stale-authority rejection, and durable audit
  operations.
- Generalize current generation/restart logic in
  `sync-engine/session-runtime.ts`, session transition stores, and
  `runner/runner-update.ts` to runner-owned execution.
- Add direct remote-runner spawn when the target is reachable, compatible,
  authorized, and credential-provisioned.
- Add recovery fork UX for an unreachable source. Do not add timeout election or
  forced takeover.
- Reconcile engine legacy assignments into certificates and remove engine from
  new-session execution authority after migration.

Likely workspaces/files: shared session authority/epoch protocol; runner
coordinator/restart/peer transport; engine session migration and reconciliation;
`solid/session-reassignment-*.ts`, spawn and status UI; database migrations and
adversarial race tests.

Exit criteria:

- Concurrent attempts produce at most one accepted epoch; stale output is
  quarantined.
- Graceful handoff preserves a verified frontier and never overlaps execution.
- Loss of the source offers a visible fork and cannot silently mutate the old
  transcript.
- Direct cross-runner spawn works through an engine outage when all explicit
  prerequisites are met.

### Stage 6 — Hardening, rollout, and local-first cutover

**Standalone value:** the mesh becomes the default supported product path with
bounded storage, secure updates, operational tooling, and migration/rollback.

Scope:

- Add signed release manifests rooted in the installer, adjacent-version
  compatibility, prior-release rollback, service-worker precache, snapshot/log
  compaction, blob garbage collection, quotas, backup/export/import, and local
  replica/vault erase.
- If selected, add a separately deployable encrypted rendezvous/relay while
  retaining direct/manual/VPN routes.
- Complete certificate expiry/renewal, revocation UI/gossip, suspicious clock
  handling, peer diagnostics, audit export, and lost-device workflows.
- Run chaos, fuzz, malicious-peer, DNS-rebinding, CORS/CSRF, resource
  exhaustion, partition/convergence, update interruption, and all-platform
  standalone tests.
- Migrate all active sessions and prompt/workspace data, make runner authority
  default, retain a release-scoped rollback switch, then remove obsolete engine
  bridge paths in a later cleanup PR rather than the cutover PR.

Likely workspaces/files: all production workspaces, release/migration scripts,
CI, migrations, and docs. Keep each PR focused even if the stage issue has
several hardening PRs.

Exit criteria:

- The success criteria in `docs/local-first-architecture.md` pass on every
  supported runner target and adjacent release pair.
- Storage remains bounded under long-running sync and tombstones are never
  collected before safe frontiers.
- Existing installations migrate atomically and can roll back without losing
  acknowledged local operations.
- The default UI and telemetry no longer require the engine for runner-owned
  work.

## Cross-stage testing strategy

Every stage adds deterministic, in-process tests with fake clocks and transports
before network integration tests. A reusable mesh harness should model engine,
runners, browser profiles, partitions, duplicate/reordered/dropped frames, clock
skew, crashes, restarts, version skew, and revoked grants. Property tests assert
idempotence, commutativity for concurrent mergeable operations, and projection
convergence from randomized valid operation order.

Canary-secret tests inspect browser storage/responses, assets, replicas, P2P
captures, logs, and runner commands. Authority tests use valid signatures with
unauthorized, stale, and equivocating operations—not syntax-only failures.
Implementation PRs run focused tests plus repository checks, and never overlap
the full suite with policy scans that create temporary invalid files.

## Alternatives considered

- **Authoritative engine plus service worker:** rejected because caching
  `/app.js` does not replace engine-owned auth, orchestration, provider calls,
  snapshots, or runner command routing in `sync-engine/index.ts`,
  `sync-engine/realtime.ts`, and `sync-engine/sessions.ts`.
- **Copy all of `sync-engine/` onto each runner:** rejected because it spreads
  Google/OAuth, global users, release management, and engine credential keys;
  creates competing central databases; and violates workspace imports. Extract
  narrow domain/runtime code to `shared/` and use least-privilege host adapters.
- **Elect any peer or use timeout takeover:** rejected because tabs cannot run
  filesystem tools and a partitioned old runner may still execute. Without a
  reachable fencing authority, election can duplicate provider charges and shell
  effects. Use signed graceful handoff; otherwise fork for recovery.
- **Replicate SQLite files/SQL or row-wide LWW:** rejected because browser
  storage and schemas differ, partial unique indexes are projection invariants,
  and row-wide winners lose field-level edits while hiding session split brain.
- **cr-sqlite everywhere:** rejected from the critical path. It does not solve
  IndexedDB, grants, secret filtering, or executor authority, and compatibility
  across Bun SQLite, macOS, standalone compilation, architectures, and libc
  targets is unverified. It may be prototyped behind a projection adapter.
- **Automerge everywhere:** rejected as the initial canonical model. A JSON CRDT
  does not define executor authority, credential exclusion, blob bounds, or
  relational queries. Its documented browser/Node/Vite support makes it a good
  bounded prompt or transport candidate, but Bun standalone support is
  unverified.
- **Yjs everywhere:** rejected because its collaborative editor strengths do not
  solve a single-writer side-effecting session. Consider it only for
  character-level prompt collaboration after the Stage 2 spike.
- **Runner-only hub/no tab transport:** rejected because the epic includes tab
  peers and disconnected tabs may have operations to exchange. Runner WebSockets
  stay preferred; `BroadcastChannel` and WebRTC cover tab paths.
- **WebRTC for every link:** rejected because direct WebSockets are simpler for
  loopback/LAN and large sync; WebRTC requires signaling and sometimes TURN. Use
  it only where browser-to-browser or NAT traversal needs it.
- **One account key or automatic secret copy to all runners:** rejected because
  one compromise becomes account-wide and revocation requires global rotation.
  Use per-device keys/grants and explicit per-runner credential envelopes.

## Open product questions

These need human decisions. Defaults below keep implementation moving without
changing the core replication/executor architecture.

1. **Offline grant lifetime and revocation risk.** Proposed default: device
   certificate 90 days, workspace write grant 30 days, runner credential
   envelope no longer than the underlying credential and at most 30 days; cached
   reads remain after expiry but new writes/execution stop. Is a 30-day
   stale-revocation window acceptable, or should sensitive workspaces be much
   shorter?
2. **Which runners receive provider secrets?** Proposed default: explicit
   per-credential “Available offline on runner X” opt-in; never all runners and
   never browser profiles. Should the runner selected for a new session prompt
   for one-click provisioning while online?
3. **LAN exposure and certificate UX.** Proposed default: loopback write access
   first; LAN serving is opt-in and write-capable only after a pinned HTTPS
   certificate/device pairing. Is read-only plain HTTP on a trusted LAN useful,
   or should all non-loopback HTTP be refused?
4. **Remote outage guarantee.** Proposed default: support direct URLs,
   user-managed VPNs, cached WebRTC routes, and manual signaling; define a
   separately deployable encrypted rendezvous/relay before promising arbitrary
   remote reachability. Should Q Mush operate that relay, ship a self-hosted
   component, or explicitly scope the epic to routes users already have?
5. **Recovery from an unreachable executor.** Proposed default: only a recovery
   fork; never automatic takeover. Is preserving one canonical session worth
   adding a future quorum/fencing service, with its new availability and trust
   dependency?
6. **Browser storage scope.** Proposed default: persist workspace projections
   and attachments opened by that profile, with configurable quota/LRU for blob
   bytes; never credentials. Should a “pin workspace for offline” control be
   required before downloading all history/attachments?
7. **Prompt conflict experience.** Proposed default: field-level LWW with losing
   body revisions retained and a compare/restore UI. Is simultaneous
   character-level prompt editing important enough to adopt Automerge/Yjs in
   Stage 2?
8. **Engine privacy role.** This design keeps a readable engine replica because
   today's engine owns SQLite and orchestration. Should a later milestone make
   the engine an end-to-end-encrypted blind backup/relay? That requires key
   recovery, search, and web-login product design and is outside #46's initial
   stages.
9. **Multi-user collaboration.** The current schema and APIs are user-owned.
   This design authenticates multiple devices for one user and keeps workspace
   grants extensible, but does not invent user sharing. Should initial grant
   roles be only `owner-device`, or should Stage 2 reserve viewer/editor roles
   for a near-term collaboration feature?
10. **Local data erasure versus audit tombstones.** Proposed default: “forget
    device” cryptographically erases that device's replica/vault, while shared
    application deletion continues to replicate soft-delete tombstones as
    required by current policy. Confirm whether regulated hard-delete workflows
    need a separate epic.

None of these questions justifies sending secrets to browsers, allowing two
executors, or making the engine's stale SQL copy the merge winner. If a chosen
answer would change one of those invariants, update and re-accept the design
before implementation.
