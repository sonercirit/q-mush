# Implementation plan and testing

This document is normative detail for the
[local-first architecture](../local-first-architecture.md). After acceptance,
create one issue per stage with the listed exit criteria. Stages preserve
compatibility during migration, but no transitional engine bridge is the target
or may be described as satisfying a later peer-first exit criterion.

## Staged implementation

### Stage 1 — Runner app and read-only full replica

**Standalone value:** every runner contains the app and a complete read-only
account copy, not merely history for sessions assigned to it.

Scope:

- Extract browser asset/manifest production from
  `sync-engine/client-build.ts`/`sync-engine/server.ts` so the signed standalone
  runner embeds and serves the same `solid/` release on a stable loopback
  origin.
- Add private runner SQLite/blob storage and migrations. Build a transitional
  bounded export stream that sends every durable, non-secret application record
  and attachment for the enrolled account: registry/trust metadata, workspaces,
  prompts, all sessions/messages/turns/questions/usage regardless of executor,
  tombstones, and blobs. Secret fields and envelopes are excluded by
  construction.
- Add full-replica inventory/checksums, resumable blob transfer, capacity
  admission, `joining`/`ready` state, and visible operation/blob progress. The
  runner is not ready until its complete exported frontier and blob manifest
  verify.
- Add a locked runner-local auth page and temporary engine-assisted pairing. Do
  not reuse the `qmr_` setup token in browser APIs. Stage 2 replaces this
  bootstrap with peer-side owner grants.
- Add a `solid/` host abstraction so reads target a runner or legacy engine,
  with origin/read-only/completeness/redundancy indicators.
- Test release manifest/cache, exact Host/Origin, CORS, DNS rebinding, full
  inventory, interruption/resume, low disk, and secret canaries.

Likely areas: `runner/runner-agent.ts`, new runner server/replica/blob modules;
`sync-engine/client-build.ts`, runner executable and temporary export endpoint;
`solid/client.tsx`/browser HTTP and connection UI; shared
manifest/export/inventory/auth types; Drizzle migrations.

Exit criteria:

- The standalone executable serves hashed app assets without Bun/source/Vite on
  the runner host.
- After catch-up, killing the engine lets a fresh paired loopback tab list/read
  every account session—including sessions assigned to other runners—and open
  every referenced attachment.
- A test fixture with cross-runner sessions, prompts, registry records,
  tombstones, and blobs proves byte-complete equality. Assignment-scoped or
  metadata-only copies fail readiness.
- Mutations remain visibly disabled and existing install/update paths work.

### Stage 2 — Durable operation core, full-replica lifecycle, and peer trust

**Standalone value:** runners have an authoritative peer-verifiable operation
store and already trusted devices can admit/revoke peers without the engine.

Scope:

- Implement canonical operation envelopes, sequence/HLC, causal frontier,
  idempotent apply, quarantine, snapshots, checkpoints, full blob manifests, and
  bounded anti-entropy in `shared/`.
- Add runner/engine migration SQLite inbox/outbox/projection tables and browser
  IndexedDB projection/outbox. Make writes pass one transactional operation
  boundary.
- Implement account genesis, purpose-separated device keys, owner-signed
  capability grants/delegation/renewal/revocation, and revocation gossip. Google
  binds only initial/recovery owner identity. Persist browser keys through
  WebCrypto and runner keys privately.
- Implement joining/ready/retiring state, capacity reserve, snapshot-plus-tail
  catch-up, complete blob repair, second-runner durability receipts, safe
  compaction, and long-offline rebootstrap from any ready runner.
- Replicate prompt/workspace/runner registry/session history through domain
  operations. Browser profiles may remain partial; runners may not.
- Add `BroadcastChannel` coordination and offline/conflict/outbox UI.
- Run reproducible Automerge/Yjs spikes only for actual prompt-body needs and
  record an ADR before adding a dependency.

Exit criteria:

- Two runners partition/edit supported entities and converge from any valid
  operation order. Reload loses no locally acknowledged operation.
- A new and a deliberately long-offline runner bootstrap directly from a ready
  peer, fetch every blob, reject incompatible/incomplete snapshots, and publish
  `ready` only after checksum/root verification.
- An owner device pairs, renews, and revokes another runner with all engine
  endpoints blocked; delegation widening, stale revocation, rollback, bad
  signatures/schema/clocks, and replay fail closed.
- Browser storage and ordinary peer frames pass secret-canary tests.

### Stage 3 — Always peer-first transport and discovery

**Standalone value:** ordinary replication and live updates use endpoint-to-
endpoint peer sessions even when the engine is online; no engine service
terminates or brokers those sessions.

Scope:

- Implement authenticated peer frames over runner WebSockets: loopback first,
  then pinned-TLS LAN/manual/VPN routes and runner mDNS with opaque metadata.
- Implement WebRTC data channels for browser peers, with signaling from a
  reachable runner, manual offer/answer, cached candidates, and optional engine
  rendezvous. Add `BroadcastChannel` transport ownership.
- Enforce route order: local/direct/LAN/VPN/WebRTC first; an end-to-end
  encrypted relay only as explicit last resort. Relayed transport still carries
  one endpoint-to-endpoint peer session whose Q Mush authentication/encryption
  terminates only at A and B. Add no engine endpoint that terminates, inspects,
  authorizes, stores-and-forwards, or re-emits ordinary operations, commands,
  blobs, receipts, or streams.
- Make `solid/realtime-client.ts` a peer transport multiplexer and migrate live
  browser commands to authority runners while retaining narrow legacy adapters
  behind a migration flag.
- Add grant intersection, revocation priority, flow control, operation/blob
  quotas, endpoint-pair route diagnostics, and path assertions.

Exit criteria:

- With the engine healthy, captures prove ordinary runner/browser replication,
  commands, and live updates are endpoint-to-endpoint peer sessions with zero
  engine broker hops. A relay test may show transport bytes passing through an
  engine-operated fallback only after direct failure, while proving the engine
  has no peer keys/plaintext or durable frame queue.
- Blocking engine application data sockets changes no established peer flow.
  Failed direct connectivity yields a visible `Relay fallback` or `No route`,
  never silent engine mediation.
- Loopback, LAN, manual URL/signaling, WebRTC failure, NAT no-route, relay,
  revocation, and incompatible protocol states are tested and unambiguous.
- Discovery reveals no account, workspace, path, session, or provider metadata.

### Stage 4 — Peer credential plane

**Standalone value:** user-entered secrets and existing OAuth material reach
authorized runners without credential-provisioning engine round-trips.

Scope:

- Add certified X25519 runner envelope keys, physically separate private vaults,
  target-bound envelope codec/channel, per-version policy, delivery receipts,
  replay/rollback protection, resealing, expiry, revoke/erase, and target
  availability UI as specified in [credentials.md](credentials.md).
- Add a runner-origin secret-entry form for API keys, generic LLM endpoint/keys,
  and Brave keys. The receiving runner independently seals to authorized runner
  keys and distributes directly. Browser persistence and every engine route are
  structurally excluded.
- Refactor OpenAI/OpenRouter OAuth so the engine performs only registered
  authorization callback/code exchange, seals immediately to the initiating
  runner's one-time key, retains no token, and performs no target fan-out.
  Implement runner-side refresh where provider semantics permit.
- Migrate legacy engine-held credentials by sealed handoff, target peer
  distribution, verified receipts, then ciphertext clearing. Label incomplete
  migrations honestly.
- Add canary, traffic, wrong-target, callback-mix-up, revoked/expired policy,
  crash/export/log, and last-secret-copy tests.

Exit criteria:

- With all engine addresses firewalled, a runner creates/rotates/revokes API,
  generic endpoint/key, and Brave credentials; all authorized reachable runners
  receive distinct envelopes and can use them. Engine request count is zero.
- An OAuth test observes only handshake traffic, no durable engine token, and
  peer-only fan-out/rotation after the initiating runner receives it.
- No plaintext or envelope ciphertext appears in browser persistence, ordinary
  operations/snapshots/blobs, tools, bundles, exports, diagnostics, or logs.
- A target cannot open another target's envelope; replay/rollback/policy changes
  fail closed; offline delivery resumes directly from an authorized runner.

### Stage 5 — Runner-local executor and direct session authority

**Standalone value:** runners execute complete sessions and cooperate directly;
the engine is absent from model, command, and authority paths.

Scope:

- Extract runtime-neutral provider/model/agent-loop and persistence domain logic
  from engine modules into `shared/`, with host adapters. `runner/` never
  imports `sync-engine/`.
- Run the coordinator/provider adapter on the runner and invoke existing runner
  tool/workspace/container/attachment modules locally instead of through
  `RunnerCommandBroker`.
- Implement epoch-zero authority, executor sequence, durable receipts,
  write-ahead tool start/finish, local deltas, final operation/blob publication,
  and routing for create/continue/follow-up/steer/answer/stop/compact.
- Implement monotonically increasing authority certificates, direct graceful
  drain/fence/offer/accept handoff, stale-authority rejection, direct remote
  spawn, and visible recovery fork. Do not add timeout takeover.
- Remove the engine from authority for newly migrated sessions; legacy execution
  remains behind an explicit temporary capability flag.

Exit criteria:

- Kill/block the engine before and during turns. Runners create, continue,
  steer, answer, stop, compact, spawn, call providers, and use local tools with
  durable replicated transcript/usage.
- Concurrent authority attempts accept at most one epoch; graceful handoff never
  overlaps; stale output quarantines; unreachable source can only fork.
- Loss of an executor leaves its full verified history readable on every ready
  runner and does not affect unrelated sessions.
- Restart/ambiguous external-effect tests never blindly duplicate an interrupted
  tool call.

### Stage 6 — Hardening and local-first cutover

**Standalone value:** full-replica, peer-first operation is the default
supported product with bounded growth, migration, and rollback.

Scope:

- Add signed peer-distributable releases, adjacent-version compatibility,
  rollback, service-worker precache, compaction/garbage collection, storage
  growth/reserve UI, encrypted backup/export/import, removable catch-up seed,
  safe retirement, and replica/vault erase.
- If selected, ship a separately deployable opaque rendezvous/relay while
  preserving direct/manual/VPN priority and explicit fallback status.
- Complete grant expiry/renewal, revocation UI/gossip, suspicious clocks,
  credential rotation/recovery, route/replica diagnostics, audit export, and
  lost-device workflows.
- Run chaos, fuzz, malicious-peer, full-replica compromise, DNS rebinding,
  CORS/CSRF, resource exhaustion, partitions, update interruption, huge/old
  catch-up, and all-platform standalone tests.
- Migrate every account/session/blob and eligible credential, make runner
  authority/default peer routes mandatory, then remove obsolete engine bridge,
  fan-out, token-vault, and ordinary data APIs after a release-scoped rollback
  window.

Exit criteria:

- All architecture success criteria pass on every target and adjacent release.
- Every ready runner remains complete under long-running growth; compaction,
  deletion, low disk, offline members, and retirement lose no acknowledged
  operation/blob.
- Existing installs migrate atomically and can roll back without losing local
  operations or leaving credentials in the engine.
- Default UI/telemetry and steady-state operation issue no engine requests
  except explicit Google/OAuth, optional rendezvous/relay, update-source, or
  backup-peer actions.

## Cross-stage testing strategy

Every stage first adds deterministic in-process tests with fake clocks,
transports, disks, and vaults. A reusable mesh harness models optional engine,
multiple full runners, browser profiles, partitions, duplicate/reordered/dropped
frames, long offline periods, compacted logs, partial blobs, disk pressure,
clock/version skew, crashes, restart, malicious peers, and revoked grants.
Property tests assert idempotence, commutativity for mergeable operations,
projection convergence, and full-runner inventory equality.

Topology tests instrument endpoint pairs and bytes by channel. A healthy engine
must not receive ordinary data merely because it is available. Direct route
failure must exercise explicit opaque fallback/no-route behavior. Large-state
tests prove catch-up from peers without engine hairpinning and bound memory,
frame, decompression, and concurrent chunk use.

Canary-secret tests inspect browser requests/memory/storage, assets, ordinary
replicas, operations, snapshots, blobs, P2P channels, relay captures, logs,
crashes, exports, and runner commands. Credential-plane tests separately inspect
target binding and ciphertext uniqueness. Authority tests use cryptographically
valid but unauthorized/stale/equivocating records, not syntax-only failures.

Implementation PRs run focused tests plus repository checks. Full test suites
must not overlap repository-policy scans that temporarily create invalid probe
files.
