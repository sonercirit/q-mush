# Implementation plan and testing

This document is normative detail for the
[local-first architecture](../local-first-architecture.md). After acceptance,
create one issue per stage with the listed exit criteria. Transitional engine
adapters never satisfy a later peer-first criterion.

## Staged implementation

### Stage 1 — Anonymous runner app and read-only full replica

**Standalone value:** a runner serves Solid locally, an anonymous user can enter
without Google, and every runner contains a complete read-only account copy.
Solid remains an on-demand client, not another replica.

Scope:

- Extract one signed browser asset/manifest build from engine Vite serving so
  the standalone runner embeds and serves `solid/` at a stable loopback origin.
- Add runner SQLite/blob storage and migrations. Add a temporary bounded engine
  export containing every ordinary record/blob for an enrolled legacy account,
  regardless of session executor. Structurally exclude provider secrets and web
  login tokens.
- Add runner inventory/checksum, resumable blobs, capacity admission, and
  `joining`/`ready` progress. Readiness requires complete frontier/tombstones/
  manifest.
- Add device-key anonymous account genesis and locked local physical browser
  pairing. Do not require `/api/auth/session`, Google, or reuse `qmr_` tokens.
- Add a Solid host/query abstraction: bounded active-view reads from runner or
  migration engine, partial cache labeling, no IndexedDB replica/outbox, and
  origin/completeness indicators.
- Test manifests, Host/Origin/CORS/DNS rebinding, anonymous startup, full
  inventory, interruption/low disk, browser non-membership, and secret canaries.

Exit criteria:

- A fresh standalone executable starts anonymous without engine traffic and
  serves hashed assets without Bun/sources/Vite.
- After catch-up, killing the engine lets a paired tab list/read every session
  and attachment from the runner, including other executors' sessions.
- Cross-runner records, all five agent-session entities, tombstones, and blobs
  prove byte-complete runner equality; scoped/metadata-only copies fail.
- Browser storage contains only bounded views/drafts and cannot issue a
  frontier/ack or satisfy readiness. Mutations remain visibly disabled.

### Stage 2 — Operation core, runner lifecycle, and peer trust

**Standalone value:** runner replicas converge and owner devices administer
trust without the engine.

Scope:

- Implement canonical operations, partition classification, sequence/HLC, causal
  frontiers, idempotent apply, quarantine, snapshots, checkpoints, full blob
  manifests, and bounded anti-entropy in `shared/`.
- Add runner and migration-engine inbox/outbox/projections. All shared writes
  cross one transactional operation boundary. Do **not** add a browser operation
  store; Solid submits commands and invalidates/refetches views.
- Implement purpose-separated device keys, anonymous genesis, owner grants,
  delegation/renewal/revocation, and gossip. Browser grants omit replica/vault/
  execution capabilities.
- Implement joining/ready/retiring, reserve, snapshot-plus-tail catch-up,
  complete blob repair, durable subscriber receipts, safe partition-scoped
  compaction, and long-offline peer bootstrap. Browsers never count; engine
  receipt eligibility arrives with Stage 3 entitlement.
- Implement convergence for non-session and session entities and bounded Solid
  queries/drafts/conflict UI.

Exit criteria:

- Partitioned runner edits converge from any valid order and reload loses no
  runner-acknowledged operation.
- New/long-offline runners bootstrap from a ready runner, fetch every blob, and
  become ready only after verification.
- Owner pairing/renew/revoke works with engine blocked; widening, replay, stale
  revocation, bad signature/schema/clock, and partition spoofing fail closed.
- Browsers cannot invoke anti-entropy or compaction acknowledgement and ordinary
  frames contain no secret.

### Stage 3 — Optional Google linking and entitlement-scoped readable backup

**Standalone value:** anonymous state links losslessly; free accounts recover
all non-session data and paid accounts recover everything after total runner
loss.

This stage precedes peer transport cutover because migration must establish the
new durable backup before obsolete engine authority is removed.

Scope:

- Change Google login from product gate to explicit engine-account
  link/recovery. Bind stable local account/owner key with signed
  nonce/assertion; preserve IDs, operations, sessions, blobs, and peer grants.
  Add explicit existing-account merge with provenance/equivocation checks.
- Add engine-authoritative `free`/`paid` entitlement epochs and short-lived
  partition capabilities. Make readable backup default-on after linking.
- Implement the exhaustive schema partition in
  [replication.md](replication.md#engine-backup-partition-by-schema-entity),
  sanitized credential summaries, partitioned snapshots/manifests/blobs, and
  stable `tier_scope_denied` handling. Unknown/mixed free batches fail closed.
- Add independent runner-to-engine subscriber/restore protocol. It shares
  verification formats, produces entitlement-scoped durable acknowledgements,
  and may count for safety/compaction only for its stored partition. It is never
  a runner bridge or execution voter.
- Implement free-to-paid live session snapshot/tail/blob backfill with verified
  completion. Implement paid-to-free immediate scope revocation and the proposed
  30-day inaccessible quarantine/purge behind configurable policy pending open
  question 15.
- Add total-loss restore: free starts with empty session partition; paid
  restores all ordinary data/blobs; anonymous reports no backup. Rotate web
  sessions and lost-device trust state. Never imply secret recovery.

Exit criteria:

- Anonymous-to-Google linking is byte/ID-preserving under interrupted/retried
  backfill; existing-account collision requires explicit safe merge.
- Free engine accepts every non-session schema entity and rejects every five
  agent-session entities, their snapshots/references/blobs, mixed batches, and
  unknown kinds before storage/ack/download. Paid accepts both.
- Paid upgrade backfills a changing session frontier and reports completion only
  after roots verify. Downgrade stops session ingestion immediately, observes
  configured quarantine/purge, and leaves runners unchanged.
- Destroying all runners restores free non-session data but no sessions, and
  restores paid data/blobs completely through the acknowledged frontier.
  Anonymous and credential-secret loss are explicitly tested.

### Stage 4 — Private-mesh discovery and peer-first transport

**Standalone value:** admitted runners retain and recover remote routes with the
engine blocked, new runners dial candidates carried by their admission package,
and ordinary replication/commands remain endpoint-to-endpoint even while the
engine is healthy.

Scope:

- Implement authenticated runner WebSocket/WebRTC frames, loopback, pinned-TLS
  LAN/manual/VPN routes, mDNS with opaque metadata, and direct candidate checks.
  Candidate import never bypasses endpoint-key, grant, nonce, or explicit
  pairing checks.
- Maintain persistent authenticated member links. Gather host/pinned candidates,
  opportunistic UPnP/NAT-PMP/PCP mappings, and member-observed public addresses;
  sign/version/expire each set and gossip every member's latest set only through
  encrypted member channels.
- Let any mutually reachable member exchange candidates and synchronize a hole
  punch over existing links. Prefer the resulting direct path; for hard pairs,
  relay bounded endpoint-encrypted live frames through a mutually reachable
  member. Keep the existing paid engine relay as an entitled convenience, never
  the engine application or backup stream.
- Treat every stably reachable member as an anchor. Recommend and test a mapped/
  port-forwarded home runner or VPS; use the linked engine backup subscriber as
  an anchor when present. Permit an optional user-designated third-party anchor
  only after disclosing that it learns member addresses and timing.
- Put the mesh's current candidate set directly in the compact one-use
  QR/text/file admission package. Implement encrypted/authenticated expiring
  manual offer/answer for no-anchor blackout recovery and cross-account first
  contact. Neither package auto-admits or confers data authority.
- Do not implement public STUN, DHT, standalone/community rendezvous, or public
  candidate publication. After cached/direct/punch/member-relay and approved
  engine-relay attempts fail, report `No route`.
- Make Solid realtime a runner view/query/command/live multiplexer. Add route,
  anchor, and relay diagnostics, direct-upgrade attempts, grant intersection,
  revocation priority, flow control, quotas, and endpoint-pair assertions.

Exit criteria:

- With all engine addresses blocked, established anonymous/free members gossip a
  changed address privately, use a third member to coordinate a synchronized
  punch, and replicate directly. Captures prove no third-party discovery network
  learns a candidate and no Q Mush entitlement request occurs.
- A never-paired runner dials the candidates in a delayed admission package;
  wrong/replayed/expired packages and candidates without a valid grant reveal no
  frontier and cannot pair. No discovery endpoint is contacted.
- Symmetric/symmetric or blocked pairs use a mutually reachable member relay;
  where no such member or approved paid relay works, they report `No route`.
  Captures prove engine application/backup sockets never carry A-to-B frames.
- A stable member restores contact after other members move simultaneously. A
  total-move/no-anchor fixture degrades explicitly to delayed manual
  offer/answer/re-pairing rather than claiming automatic recovery.
- Healthy-engine captures show direct runner traffic and separate backup links;
  paid relay admission is entitled and opaque. Loopback/LAN/manual/WebRTC/NAT/
  mapping/relay/revocation/version cases pass, and browsers never forward
  anti-entropy.

### Stage 5 — Runner credential plane and provider authorization

**Standalone value:** all provider credentials originate, refresh, and fan out
on runners with no engine custody.

Scope:

- Add X25519 target keys, private vaults, target-bound codec/channel, versioned
  policy/receipts, replay/rollback protection, resealing, expiry/revoke/erase,
  and availability UI.
- Add runner-origin forms for API keys, generic endpoint/keys, and Brave keys;
  structurally exclude browser persistence and engine routes.
- Replace OpenAI engine authorization-code/localhost `1455` listener with the
  runner device-code flow and runner refresh. Verify production provider device
  endpoints/client/scopes/polling before enablement; API key is honest fallback.
- Move current OpenRouter PKCE callback/code exchange to a runner, since its
  caller-supplied callback has no registered client secret. Keep exact callback
  security and API-key fallback.
- Migrate API/Brave/generic secrets by verified one-time sealed handoff where
  safe. Prefer runner device-code re-auth for OpenAI; runner re-auth or bounded
  handoff for OpenRouter. Clear legacy ciphertext after receipts.
- Delete engine provider OAuth/callback/custody routes, OpenAI listener and
  settings, OpenRouter redirect/custody settings, and obsolete Solid route links
  while retaining Google auth and runner-side provider behavior.

Exit criteria:

- With engine firewalled, API/generic/Brave lifecycle, OpenAI device auth,
  OpenRouter runner PKCE, refresh, and peer target delivery work. Engine request
  count/token rows are zero.
- Engine starts no `1455` listener and exposes no OpenAI/OpenRouter provider
  callback/custody routes; Google callback still passes.
- Plaintext/envelopes are absent from browser, ordinary operations/snapshots/
  blobs, both backup tiers, tools, exports, diagnostics, crashes, and logs.
- Wrong target/replay/rollback/policy attacks fail; offline delivery resumes
  from an authorized runner.

### Stage 6 — Runner-local executor and direct session authority

**Standalone value:** runners execute sessions directly; the engine is absent
from model, command, and authority paths.

Scope:

- Extract runtime-neutral provider/model/agent-loop/domain logic to `shared/`
  with host adapters; `runner/` never imports `sync-engine/`.
- Run coordinator/provider and tools locally. Implement epoch-zero authority,
  executor sequence, durable receipts, write-ahead tool events, deltas, final
  operations/blobs, and all session commands.
- Implement fenced graceful handoff, stale rejection, direct spawn, and visible
  recovery fork; no timeout takeover.
- Send committed session data to every runner and, independently, paid backup.
  Free backup rejection must not affect execution or runner convergence.
- Remove engine authority for migrated sessions behind a rollback-scoped legacy
  flag.

Exit criteria:

- Engine kill/block before/during turns does not affect create, continue, steer,
  answer, stop, compact, spawn, provider calls, or local tools.
- At most one epoch executes; handoff cannot overlap; stale output quarantines;
  unreachable source can only fork.
- Executor loss leaves verified history on every ready runner. Free session
  history stays runner-only; paid backup advances independently.
- Restart/ambiguous-effect tests never blindly duplicate a tool call.

### Stage 7 — Hardening and cutover

**Standalone value:** anonymous, free, and paid local-first modes are supported
by default with bounded growth, restore, migration, and rollback.

Scope:

- Add signed peer-distributable releases, compatibility/rollback, service-worker
  asset precache, compaction/GC, growth UI, encrypted export, removable catch-up
  seed, retirement, and erase.
- Complete grants/revocation, tier and backup UI, suspicious clocks, credential
  recovery/rotation, route/anchor diagnostics, audit export, and lost-device
  workflows.
- Finalize candidate expiry/gossip, adaptive keepalives, opportunistic router
  mapping, anchor reachability checks, manual blackout recovery, relay bounds,
  address-recipient audit, and capture tests; no dedicated discovery component
  is deferred to hardening.
- Run chaos/fuzz/malicious-peer, readable-engine breach boundaries, entitlement
  bypass, DNS/CORS/CSRF, exhaustion, partition, update interruption, huge/old
  catch-up, total-loss restore, and all-target mesh tests.
- Migrate every account/entity/blob and credential; remove engine broker,
  execution, legacy vault, provider connect, and ordinary authority APIs after a
  release-scoped rollback window.

Exit criteria:

- All architecture criteria pass on every target/adjacent release.
- Ready runners remain complete under growth/compaction/deletion/retirement;
  engine acknowledgements apply only to their entitled partition and browsers
  never count toward replica safety or compaction.
- Anonymous use has zero engine dependency; free/paid restore exactly their
  partition; upgrades/downgrades enforce policy without runner loss.
- Default steady state issues engine requests only for explicit Google
  identity/recovery, independent default backup, linked-account anchor control,
  paid relay, or an update source—never ordinary runner traffic,
  engine-independent mesh connectivity, or provider credentials.

## Cross-stage testing strategy

Each stage begins with deterministic tests using fake clocks, transports, disks,
vaults, entitlement, and provider endpoints. A mesh harness models engine,
multiple full runners, Solid partial clients, partitions, duplicate/reordered
frames, compacted logs, partial blobs, disk pressure, clock/version skew,
crashes, malicious peers, revoked grants, tier transitions, and total runner
loss. Property tests cover idempotence, merge commutativity, projection
convergence, partition derivation, and full-runner inventory equality.

Topology instrumentation records endpoint pairs/bytes by channel, route, and
anchor/relay. A healthy engine sees only its own backup, private anchor control,
and paid opaque-relay traffic, never ordinary broker flow. Engine-blocked NAT
fixtures exercise private candidate gossip, member-observed addresses,
member-coordinated punches, member relay, admission packages, delayed manual
offer/answer, and honest `No route`. A total-simultaneous-move fixture succeeds
through a stable anchor and degrades to re-pairing when none exists. The harness
asserts that no public discovery endpoint receives candidate material, no
entitlement call gates member/manual paths, and no frontier is revealed before
endpoint authentication. Browser tests prove absence of replica/frontier/ack
capability. Restore tests physically remove all runner storage and ignore
browser caches.

Entitlement fixtures enumerate every schema entity and blob-reference shape.
Adding a schema/operation kind without classification fails tests/build. Free
mixed/unknown/session uploads and downloads fail before acknowledgement; paid
backfill remains gap-aware under concurrent writes. Downgrade fake clocks
exercise grace and purge.

Canary tests inspect browser traffic/storage/assets, runner ordinary replicas,
operations, snapshots, both backup tiers, direct/member/engine-relay captures,
candidate gossip, admission/manual packages, local router mapping, logs,
crashes, exports, and tools. Connectivity adversarial tests cover forged,
omitted, replayed, or stale candidate sets; admission-package theft; malicious
anchors; relay persistence; simultaneous address changes; and
candidate-without-grant attempts. Capture allowlists prove candidates reach only
members, explicit packages, a user-designated anchor, or the engine in its
documented tier role; public DHT/STUN/rendezvous egress fails the suite.
Credential tests separately inspect target ciphertext and verify no engine
request. OpenAI device and OpenRouter runner callback tests include denial,
expiry, slow-down, replay, mix-up, cancellation, and route removal. Full suites
must not overlap repository-policy scans that create probe files.
