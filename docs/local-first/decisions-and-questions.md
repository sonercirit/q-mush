# Alternatives and open questions

This document records rejected approaches and genuine follow-up decisions for
the [local-first architecture](../local-first-architecture.md). Open questions
may tune policy or future scope; they cannot weaken full runner replicas,
engine-free provisioning for user-entered credentials, or the always peer-first
data plane without a newly accepted design change.

## Alternatives considered

- **Authoritative engine plus service worker:** rejected because caching assets
  does not replace engine-owned auth, orchestration, snapshots, provider calls,
  or runner command routing.
- **Engine as normal WebSocket fan-out with P2P only during outage:** rejected.
  It leaves cost, latency, privacy, and failure coupling in steady state and
  violates peer-first operation. The engine may rendezvous or provide an opaque
  last-resort tunnel; it never terminates ordinary A-to-B data.
- **Engine credential provisioning while online:** rejected for user-entered
  API/generic/Brave secrets. Availability cannot depend on an unrelated control
  service. Per-device envelopes and direct runner credential channels provide
  distribution without putting secrets into ordinary replication.
- **Put sealed credential envelopes in the operation log:** rejected. Even
  target ciphertext would become copied into browsers, snapshots, backups,
  exports, and every runner's ordinary database, expanding retention/attack
  surface and making erasure ambiguous. Keep a non-forwardable runner-only
  credential plane and replicate only policy/receipts.
- **Engine-issued certificate for every admission/renewal:** rejected. Google is
  useful for first-owner identity and recovery, but steady-state owner devices
  can sign bounded grants/revocations directly. Routine engine issuance would
  recreate the availability dependency.
- **Workspace- or assignment-scoped runner replicas:** rejected for #46. A
  runner with only its sessions cannot preserve all account data when another
  host fails and makes failover/catch-up depend on placement. Every enrolled
  runner stores the full account state and all Q Mush blobs.
- **Copy all of `sync-engine/` onto runners:** rejected. That spreads
  Google/OAuth callback logic, global multi-account state, release keys, and
  legacy engine credential keys; creates competing central databases; and
  violates workspace boundaries. Extract narrow runtime-neutral code into
  `shared/` and use runner adapters.
- **Elect any peer or timeout takeover:** rejected because a partitioned old
  runner may still execute. Without fencing, election duplicates provider
  charges and shell effects. Use direct signed graceful handoff; otherwise a
  recovery fork from the fully replicated transcript.
- **Replicate SQLite files/SQL or row-wide LWW:** rejected because browser and
  schema representations differ, indexes are projection invariants, and row-wide
  winners lose field edits while hiding executor split brain.
- **cr-sqlite/Automerge/Yjs everywhere:** rejected from the critical path. None
  alone defines execution authority, full blob completeness, credential
  exclusion, trust delegation, or IndexedDB/standalone compatibility. Mature
  document CRDTs remain candidates for a real collaborative text requirement
  behind the domain operation boundary.
- **Runner-only hub with no tab transport:** rejected because browser profiles
  can author offline operations and direct WebRTC/`BroadcastChannel` paths avoid
  one runner becoming another mandatory broker.
- **WebRTC for every link:** rejected because direct WebSockets are simpler and
  more efficient on loopback/LAN and for bulk full-replica catch-up. Use WebRTC
  where browser reachability/NAT needs it.
- **One account-wide credential key:** rejected. Compromise of one runner would
  expose every current/future envelope and revocation would require global
  rotation. Independent device keys make target scope, rotation, and receipts
  explicit.
- **Lazy runner attachments with metadata-only readiness:** rejected. It lowers
  disk use but cannot promise that loss of one host loses no data. Content hash
  dedupe, compaction, admission limits, and capacity planning address growth;
  ready runners retain every accepted blob.

## Open product questions

Defaults let implementation proceed without changing the three core directives.

1. **Offline grant and secret-envelope lifetime.** Proposed default:
   owner/device certificate 90 days, write/execution grant 30 days, envelope no
   longer than its underlying credential and at most 30 days; cached reads
   remain after expiry but writes/execution stop. Should high-risk accounts use
   shorter policy profiles, and what freshness is required to change owners or
   credential policy?
2. **Runner storage admission and reserve.** Full replicas are mandatory.
   Proposed default: joining requires current data size plus 25%/a configured
   absolute reserve, warns at 80%, pauses large imports before reserve, and
   never evicts accepted blobs. What reserve/growth projection and operator
   override should ship?
3. **Blob retention and large attachment limits.** Every accepted Q Mush blob
   reaches every ready runner. What per-blob/account limits, compression policy,
   and audited tombstone retention satisfy usability and storage cost without
   creating partial replicas?
4. **Credential target policy.** Proposed default: every trusted executor runner
   receives each credential, maximizing failover, with an advanced per-runner
   exclusion and explicit availability warning. Which credential/provider types
   should default to narrower least privilege?
5. **Credential recovery.** Full ordinary replicas deliberately cannot recover
   secrets. Should Q Mush offer an optional passphrase/hardware-key encrypted
   user-held recovery export, and how are forgotten passphrase and rotation
   communicated without introducing an engine escrow key?
6. **LAN certificate experience.** Proposed default: loopback write first;
   non-loopback writes require pinned HTTPS/device pairing, and plain HTTP is
   refused or visibly read-only. Is read-only LAN HTTP worth its
   support/security surface?
7. **Remote connectivity service.** Direct/manual/VPN/WebRTC remain primary and
   relay is always explicit last resort. Should Q Mush operate an opaque relay,
   ship a self-hosted component, support standard TURN only, or promise only
   user-provided routes?
8. **Recovery from unreachable executor.** Proposed default remains recovery
   fork only. Is one canonical session worth a future quorum/fencing service,
   despite the availability/trust dependency and inability to fence arbitrary
   local shell effects?
9. **Browser cache policy.** Browser profiles are intentionally not full
   runners. Proposed default persists metadata/history plus opened blobs under a
   quota and offers “pin for offline.” What quota/LRU and user controls best
   distinguish browser cache completeness from runner durability?
10. **Prompt conflict experience.** Proposed default is field-level HLC with
    losing body revisions retained for compare/restore. Is simultaneous
    character-level editing important enough for an Automerge/Yjs spike?
11. **Optional engine backup privacy.** The engine is never the ordinary route.
    Should its optional subscriber store a readable account replica, an
    end-to-end-encrypted blind backup, or be disabled by default? Blind backup
    requires independent recovery/search design and does not affect runner
    completeness.
12. **Per-workspace replica scoping as a future option.** The accepted design
    requires full account state on every runner. If very large/team accounts
    later need scoped replicas, should that be a separately named device class
    that cannot count as a full runner, or a new quorum/placement design? It is
    explicitly outside #46 and requires a new threat/availability analysis.
13. **Multi-user collaboration.** Current APIs are user-owned. The trust format
    can reserve viewer/editor roles, but implementation need not invent sharing.
    Should initial grants expose only owner-device roles or reserve role codes
    for future compatibility?
14. **Regulated erasure.** Proposed default cryptographically erases a retired
    device while shared deletion remains audited soft-delete until safe
    retention permits byte collection. Do regulated hard-delete workflows need a
    separate epic and backup/peer acknowledgement protocol?

Resolved choices—full runner scope, peer-side routine trust, no engine traffic
for user-entered credential provisioning, OAuth-only transient engine custody,
and peer-first ordinary transport—are deliberately absent from this list.
Changing one requires revising and re-accepting the architecture rather than
selecting an implementation option.
