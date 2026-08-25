# Replication and execution authority

This document is normative detail for the
[local-first architecture](../local-first-architecture.md).

## Replica scope and storage model

A full runner replica contains all durable ordinary Q Mush state for each local
account: workspaces, prompts, trust/runner registries, credential metadata,
every session regardless of executor, messages, turns, questions, pending
inputs, usage, audit fields, tombstones, retained operations/snapshots, and
application blobs.

This is an account boundary, not a workspace, tier, placement, or recent-use
rule. Grants constrain use, not runner storage. Accounts remain isolated.
Anonymous/free runners are as complete as paid runners; tier only filters the
engine subscription.

Excluded classes are:

- provider secrets/envelopes, which use private runner vaults and the credential
  plane; only summaries/policies/receipts replicate;
- engine login/billing records and bearer tokens;
- presence, unfinished deltas, and diagnostics (final messages/status/usage do
  replicate);
- external working directories except explicitly imported attachments; and
- browser drafts/preferences/view caches.

Accepted attachments have no age/owner/workspace exemption. Reject an import
before commitment if full-runner capacity cannot accept it; every ready runner
eventually stores verified bytes.

Runners use SQLite and a content-addressed blob directory; the engine stores its
entitled projection. Both sides shard SQLite by user: each account's runner
replica and engine backup live in that account's own database file, so no two
accounts' data share a database or touch each other. Cross-account queries do
not exist. Because engine disk is expensive, S3-compatible object storage is the
engine's storage of record for shard databases and backup blobs: the engine
hydrates an account's shard into a bounded local cache on demand and its durable
acknowledgement requires the completed object-store write, never only the cache.
Solid requests bounded active views and may cache selected responses, but
receives no operation log and owns no shared outbox. A draft is shared only when
a runner accepts its command.

The logical storage layers are:

1. **Inbox/outbox operation log:** immutable operations, verification state,
   source, and rejection reason. Local durable commit precedes success.
2. **Materialized projection:** query-friendly account, session, prompt,
   workspace, registry, and credential-summary records. SQLite tables in
   `shared/database/schema.ts` remain useful projections.
3. **Blob store:** attachments and large snapshots addressed by SHA-256, with
   authorization metadata in operations and bounded transfer outside envelopes.
4. **Control store:** device keys, grants/revocations, peer checkpoints, schema
   versions, runner replica readiness, engine entitlement, and credential
   delivery metadata. Vault ciphertext remains physically separate.

SQLite rows are projections, not synchronization records. SQL/file replication
would couple schemas and erase causal intent. Stores must write commands through
one transactional operation/projection boundary. Signed snapshots accelerate
bootstrap but cannot invent authority.

## Engine backup partition by schema entity

The target maps every table currently exported by `shared/database/schema.ts`.
This list is exhaustive and disambiguates the web login table named `sessions`
from agent sessions. Future entities must declare a partition before shipping;
unknown kinds fail entitlement closed.

**Non-session backup (free and paid):**

- `users` — account profile and Google binding; anonymous identity remains local
  until linking.
- `workspaces` and `prompts` — configuration/content.
- `provider_credentials` — a sanitized summary only: ID, provider, label,
  source, fingerprint, default/connectivity metadata. Exclude
  `encrypted_credential`; move sensitive generic `base_url` to the vault.
- `provider_quota_settings`, `provider_quota_reset_receipts`,
  `provider_credential_workspaces`, and `attachment_fallbacks` — non-secret
  provider settings, receipts, relations, and fallback selection.
- `runners` — sanitized device/trust/recovery metadata. Replace legacy token
  fields with grants; never replicate reusable bearer secrets.
- `runner_workspaces` — runner/workspace capability relations.

**Session backup (paid only; free rejects):**

- `agent_sessions` — root, configuration, assignment, status, usage, title,
  captured agent file, and execution state;
- `agent_session_turns` — turn boundaries/execution state;
- `agent_pending_inputs` — queued content and image references;
- `agent_question_requests` — tool questions and answers; and
- `agent_messages` — transcript, tool, reasoning/error content, and image refs.

**Engine control (neither peer partition):** `sessions` contains HttpOnly web
login tokens, not agent history. It remains engine-local in both tiers, is
rotated/recreated during login/recovery, and never goes to runners.

All audit fields, tombstones, and relations inherit their entity's partition. A
blob is session-tier when all live references are from the five `agent_*`
entities, including pending-input/message images. Any live non-session reference
admits it to the non-session partition. Free rejects session snapshots,
operations, manifests, references, and bytes—not only SQL projections.

New trust/operation entities are non-session unless they contain session
payloads. Snapshots split by partition. Secrets remain excluded from both tiers.

### Entitlement enforcement

The engine is authoritative for `anonymous`/`free`/`paid` entitlement. A runner
cannot assert paid scope. After Google authentication, a short-lived signed
subscription capability names account ID, allowed partition(s), expiry, and
subscription purpose. The engine authenticates every upload and download, parses
the bounded entity/blob-reference envelope, and applies these rules before
durable write or acknowledgement:

- anonymous accounts have no engine subscription endpoint;
- free capabilities allow only the non-session partition and reject a batch
  containing a session entity, session snapshot, session-only blob/reference, or
  unknown kind; and
- paid capabilities allow both partitions, subject to normal authorization and
  validation.

Mixed batches fail atomically or are split by the sender before upload; the
engine never silently drops a session record and acknowledges the containing
frontier. Rejection uses a stable `tier_scope_denied` result without echoing
content. Download/restore uses the same filter so stale paid bytes cannot leak
through a free subscription. Entitlement changes invalidate old capabilities,
are checked at connection and each bounded transaction, and are auditable
without recording content. Rate/size limits are independent of tier.

The readable engine subscriber verifies signatures, causal rules, tombstones,
checksums, and blob hashes. Its durable ack advances the relevant backup
frontier and may establish total-runner-loss recovery for that tier. UI reports
`runner copies` and `engine backup` separately. It is a normal replication peer
subscriber, but never execution authority or an ordinary A-to-B route. Its
partition-scoped durable acknowledgement participates in replica safety and
compaction only for data that tier actually stores.

### Tier transitions and restore

- **Anonymous to logged in:** Google proves the external identity while the
  initiating owner device signs a link binding the existing account/trust root.
  No new local account is created and no ID is rewritten. If the Google account
  has no prior Q Mush account, the engine adopts that stable account ID and
  backfills the tier partition. If it already has data, the UI requires an
  explicit, resumable merge/import; operations keep IDs and provenance,
  collisions/equivocation fail closed, and neither side is overwritten.
- **Free to paid:** issue a paid capability, inventory the complete session
  partition from any ready runner, upload a partitioned snapshot plus operation
  tail and all session-only blobs, and verify roots. New session operations may
  stream concurrently but `Paid backup complete` remains false until no gap
  exists through the displayed frontier.
- **Paid to free:** revoke paid capabilities immediately, reject new session
  uploads/downloads, continue the non-session subscription, and mark the paid
  session backup quarantined. Proposed policy retains inaccessible bytes for 30
  days for re-upgrade, then cryptographically purges session snapshots,
  operations, projections, and unshared blobs while retaining required audit
  metadata without content. Immediate access/ingestion revocation enforces the
  free entitlement; the short quarantine protects users from accidental
  downgrade or transient billing failure without imposing indefinite operator
  cost or surprise long-term retention. Exact grace and billing-failure
  treatment remain open question 15; no runner data is removed.
- **Restore after total runner loss:** Google recovery creates a fresh runner
  device/trust transition. Free restores only the non-session partition and
  explicitly starts with no session history. Paid restores both partitions and
  all application blobs through the engine's acknowledged frontier. The new
  runner is `joining` until its entitled restore verifies; it then becomes a
  full local account replica for the recovered set. Anonymous has no engine
  restore. Credential summaries may return, but vault secrets do not.

## Operation envelope

Canonical bounded encoding uses CBOR by default; canonical JSON is acceptable
only for read-only migration:

```text
operationId: UUIDv7
schemaVersion: positive integer
partition: non-session | session
kind: namespaced domain operation
scope: { accountId, workspaceId | absent }
author: { deviceId, keyId }
authorSequence: monotonic uint64
clock: { physicalMs, logical, deviceId }
parents: compact causal frontier / operation hashes
entity: { type, id }
payload: kind-specific value or blob refs
execution: { sessionId, epoch } | absent
signature: Ed25519 over canonical preceding fields
```

- `operationId` is the idempotency key. Unique `(deviceId, authorSequence)`
  detects rollback, gaps, and equivocation.
- HLC `(physicalMs, logical, deviceId)` orders otherwise concurrent register
  writes without assuming synchronized clocks. Extreme jumps quarantine.
- `parents` distinguishes happened-before from concurrency. Peers exchange
  compact author ranges/checkpoints rather than full vectors in every payload.
- Signatures authenticate author/scope/grant and, for executor operations, the
  epoch certificate. The declared partition is validated from `kind` and
  references; a signature cannot relabel a session as non-session.
- Unknown optional fields survive forwarding. Unknown kinds quarantine on
  runners and fail engine entitlement closed; they are never generic row
  patches.

UUIDv7 identity, audit fields, and soft deletes remain projection conventions.

## Peer-first synchronization protocol

The shared protocol is transport-independent. Runner-to-runner and
runner-to-engine subscriptions use authenticated endpoint sessions, but only
runners are full replica members. The browser uses bounded query/command/live
APIs and does not send `frontier`, `need`, `operations`, blob-manifest, `ack`,
or snapshot frames.

1. `hello`: runner identity, signed nonce, account membership, grants,
   protocol/app versions, limits, partition capability, and replica state
   (`joining`, `ready`, or `retiring`).
2. `frontier`: partitioned operation ranges/checkpoints, compatible snapshot
   frontiers, and blob-manifest roots after mutual authorization.
3. `need` / `operations`: bounded missing ranges. The receiver verifies shape,
   signature, grant, authority, causal dependencies, tier, and limits before
   atomic apply.
4. `blob_manifest` / `blob_need` / `blob_chunk`: resumable, hash-verified,
   partition-aware transfer after the referencing operation is authorized.
5. `ack`: highest durable ranges, blob roots, and rejected/quarantined IDs. This
   means durable validated receipt, not socket receipt.
6. `presence` and stream frames: bounded ephemeral events outside frontiers.

Anti-entropy runs at connect and periodically. Peers serve ranges symmetrically;
there is no server winner. Private mesh gossip or an onboarding/manual package
supplies an untrusted candidate only. It neither admits a replica nor authorizes
`hello`; the runner verifies endpoint key, account grant, signed nonce, and
protocol before revealing a frontier. Runners prefer direct links and never
upload to the engine merely so another runner can download. Each logged-in
runner may independently synchronize the engine backup, with duplicate
operations deduped; the engine is never a bridge. A mutually reachable member or
paid engine relay carries only endpoint-encrypted live frames and cannot
materialize or merge them.

Current bounded codecs are reusable inputs, but durable changes gain peer
envelopes and streams remain ephemeral. The in-memory engine command ledger
cannot remain receipt authority.

## Full-runner lifecycle and storage growth

### Admission and catch-up

A new or long-offline runner follows this state machine:

1. An owner peer signs full-account membership and verifies capacity for current
   projection, operation tail, complete blobs, and growth reserve.
2. The `joining` runner downloads the newest compatible runner snapshot in
   resumable verified chunks. If no runner survives, an entitled engine restore
   is the source, with the tier-specific loss disclosed.
3. It applies the operation tail and continuously follows new operations. A
   compacted obsolete checkpoint requires a newer snapshot.
4. It compares the complete blob manifest and fetches missing chunks from ready
   runners; an engine restore provides only its entitled manifest.
5. It verifies frontier, projection checksum/version, tombstone coverage, and
   blob root before signing `ready`.

A partial read during joining is labeled partial and cannot satisfy redundancy,
execute by default, or trigger collection. UI reports remaining data, source,
gaps, space, and errors. Portable encrypted seeds remain a transport
optimization and require live signature/hash/grant validation.

### Capacity, acknowledgements, and compaction

Full runner disk growth follows total account history. Display logical/physical
bytes, growth, reserve, and completeness. Deduplication and compaction reduce
representation cost, not scope. Blob LRU, download-on-open, assignment-scoped
history, and silent skips are forbidden. Pressure rejects large imports or
requires shared deletion/retirement.

A local write immediately schedules every reachable runner and entitled engine
partition. Until another runner acknowledges it, UI reports one runner copy;
until the engine acknowledges it, UI separately reports engine backup pending or
not included by tier. An engine acknowledgement can protect against total runner
loss but does not turn the engine into an execution peer.

Compaction requires a compatible snapshot on at least two eligible durable
replicas plus retained coverage for unsuperseded frontiers. Every ready runner
is eligible for both partitions. The readable engine subscriber is eligible only
for the partition its current entitlement stores: non-session for free, both for
paid, and neither for anonymous. Thus a free account with one runner and its
engine backup may compact non-session history but must retain session history
until another ready runner has its snapshot. A browser never counts. Retired
runners stop blocking and bootstrap anew.

Tombstone/blob collection likewise uses causal acknowledgement from every
required durable member of that partition plus retention/reference checks. It
includes the entitled engine subscriber and ready runners, never browser caches.
A tier downgrade follows its explicit quarantine/purge lifecycle rather than
letting the former paid copy indefinitely block free session collection.

## Conflict policy

Entity rules are normative in [convergence.md](convergence.md). They use
causal/HLC registers, remove-wins tombstones, immutable requests/events, and
certified executor streams. No engine copy is a universal winner.

## Session execution protocol

### Authority certificate

Session creation binds `(sessionId, runnerId, epoch = 0)`. The certificate is:

```text
session ID + epoch + runner device key + previous epoch frontier + grant ID
```

The creator's grant plus target acceptance establishes epoch zero. Reassignment
requires a quiescent source offer and target acceptance. The source fences
itself before acknowledging; the target starts epoch `n + 1` only after both
records are durable. No engine co-signature or browser vote is accepted.

If the source cannot participate, any ready runner offers **Fork for recovery**
from the last verified transcript. This is not takeover; returning original and
fork remain separate. Replication preserves history but cannot prove an
unavailable process stopped external effects.

### Local execution path

1. The authority runner durably accepts a command and emits a receipt.
2. It reads its local full projection and target-bound vault credential.
3. It runs provider/model/agent logic and appends turn/message operations around
   external effects.
4. Tools invoke runner workspace/container modules directly, not an engine
   command broker.
5. It sends live deltas to browser clients and committed operations/blobs to
   runner replicas.
6. Its independent engine subscription sends the non-session or paid session
   partition as entitled; another runner's path never traverses that engine
   link.

Migration extracts runtime-neutral agent/provider/domain pieces into `shared/`
and adds host adapters. `runner/` never imports `sync-engine/`.

### External side effects

Convergence cannot make arbitrary shell commands exactly once across a crash:

- persist `tool_started(callId, epoch, argumentsHash)` before dispatch;
- persist bounded output under policy;
- persist `tool_finished` after result;
- never blindly rerun an indeterminate side-effecting call; and
- use provider idempotency where available without claiming universal billing
  exactly once.

The guarantee is one concurrent authority, not exactly-once external effects.

## Reconnection and convergence

Runners authenticate trust, prioritize revocations, exchange partitioned
operation/snapshot/blob frontiers, and apply control records before dependent
data. Executor output is checked against epoch; unsupported kinds quarantine;
projection uniqueness repairs through domain rules. A ready runner cannot keep
missing attachments. Browser clients invalidate/refetch affected active views
from a runner instead of participating in anti-entropy.

No engine projection overwrites peer work. Its valid subscribed operations obey
normal causal rules; invalid executor/control records quarantine. A free engine
cannot become a source of session data. Security ambiguity fails closed.

## CRDT library decision

Start with a small domain-operation layer, not a whole-database CRDT. State is
mostly registers, observed-remove sets, immutable events, and executor streams.
Do not invent a text CRDT. Evaluate a mature library only for a demonstrated
character-editing need after compatibility/resource tests; it still would not
solve authority, blobs, tiers, trust, or secrets.
