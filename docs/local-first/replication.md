# Replication and execution authority

This document is normative detail for the
[local-first architecture](../local-first-architecture.md).

## Replica scope and storage model

A **full runner replica** contains the complete durable Q Mush application state
for every account enrolled on that runner. For each such account this includes
all workspace and prompt-bank records, runner/device/trust registries, provider
credential summaries and availability receipts, sessions regardless of assigned
executor, messages, turns, questions, pending inputs, usage, audit fields,
tombstones, operation history needed after compaction, snapshots, and every
referenced application blob.

Full replication is an account boundary, not a workspace-placement rule. A
runner cannot subscribe only to its assigned sessions, recently opened
workspaces, or selected entities. Workspace grants still authorize who may view,
edit, execute, or use a credential; they do not create partial runner storage.
An engine serving multiple users does not disclose one account to another.

The only classes outside ordinary full replication are precisely bounded:

- provider/skill plaintext and per-device sealed envelopes use the credential
  plane and private runner vault described in [credentials.md](credentials.md);
  their non-secret summaries, policy, versions, and delivery receipts do
  replicate;
- live presence, model deltas before final commit, and transport diagnostics are
  ephemeral; their durable final messages/status/usage replicate;
- a runner's external working directory is not silently copied. Workspace path
  metadata and files deliberately imported as Q Mush attachments replicate;
  source trees and other tool-accessed files remain runner-local resources; and
- browser drafts/preferences remain profile-local unless promoted to a shared
  entity.

There is no size, age, session-owner, or workspace exemption for a durable Q
Mush attachment. Admission applies before commitment: if an attachment exceeds
product limits or no full-replica capacity policy can accept it, the authoring
runner rejects the import rather than creating a permanently partial record.
Once accepted, every ready runner must eventually store its verified bytes.

Each runner uses SQLite plus a private content-addressed blob directory. A
browser profile uses IndexedDB and may keep a partial projection/blob cache. An
optional engine backup may use SQLite but follows the same peer protocol. The
logical layers are:

1. **Inbox/outbox operation log:** immutable operations, verification state,
   source peer, and rejection reason. Local durable commit precedes a success
   response.
2. **Materialized projection:** query-friendly account, session, message,
   prompt, workspace, registry, and credential-summary records. Bun peers retain
   Drizzle/SQLite tables in `shared/database/schema.ts` where practical;
   browsers use IndexedDB and shared codecs.
3. **Blob store:** attachments and large snapshots addressed by SHA-256, with
   authorization metadata in operations and bounded transfer outside operation
   envelopes.
4. **Control store:** device keys, grants, revocations, peer checkpoints,
   protocol versions, replica membership/readiness, and credential-envelope
   metadata. Vault ciphertext is physically and cryptographically separate.

SQLite rows are projections, not synchronization records. Replicating SQL
`UPDATE` statements or database files would couple peers to one schema, lose
causal intent, and make current partial unique indexes conflict during
multi-writer merge. Existing stores such as `sync-engine/prompt-store.ts` and
`sync-engine/session-store.ts` must write domain commands through one
transactional operation/projection boundary rather than remain another source of
truth.

A transactionally maintained outbox avoids a dual-write window on Bun peers. A
browser writes its operation and projection in one IndexedDB transaction. A
background compactor can create a signed snapshot after all operations in its
frontier are durable; snapshots accelerate bootstrap but never invent execution
or trust authority.

### Operation envelope

The wire encoding is canonical and bounded (canonical CBOR by default; canonical
JSON is acceptable only for the first read-only migration stage):

```text
operationId: UUIDv7
schemaVersion: positive integer
kind: namespaced domain operation
scope: { accountId, workspaceId | absent }
author: { deviceId, keyId }
authorSequence: monotonic uint64
clock: { physicalMs, logical, deviceId }       # hybrid logical clock
parents: compact causal frontier / operation hashes
entity: { type, id }
payload: kind-specific value or blob refs
execution: { sessionId, epoch } | absent
signature: Ed25519 over canonical preceding fields
```

- `operationId` is the idempotency key. Unique `(deviceId, authorSequence)`
  detects rollback, gaps, and equivocation.
- A hybrid logical clock (HLC) advances on local durable writes and received
  operations. `(physicalMs, logical, deviceId)` orders otherwise concurrent LWW
  register assignments without assuming synchronized clocks. Extreme forward
  jumps are quarantined and shown as a device clock fault.
- `parents` distinguishes happened-before from concurrent writes. Peers exchange
  compact per-author ranges/checkpoints rather than a full vector in every
  payload.
- A signature authenticates author and scope; the verifier also evaluates the
  delegated grant and, for executor-owned operations, the epoch certificate.
- Unknown optional fields survive forwarding. An unknown operation kind remains
  durably quarantined and advances no projection; it is never interpreted as a
  generic row patch.

Operation-level schema versions allow projections to rebuild from a snapshot and
operation tail. UUIDv7 identity from `shared/ids.ts`, audit fields from
`shared/database/audit-columns.ts`, and soft deletes from
`shared/database/schema.ts` remain the application representation.

## Peer-first synchronization protocol

The protocol lives in `shared/` and is transport-independent. Every ordinary
sync session is endpoint-to-endpoint, including while the engine is healthy. A
direct WebSocket, WebRTC data channel, or explicitly selected end-to-end
encrypted fallback tunnel carries the same frames:

1. `hello`: device identity, signed nonce, account/full-replica membership,
   delegated grants, protocol/app versions, maximum frame size, compression,
   blob capabilities, and replica state (`joining`, `ready`, or `retiring`).
2. `frontier`: per-account/workspace operation ranges/checkpoints, compatible
   snapshot frontiers, and blob-manifest root. No private entity metadata is
   revealed before mutual authentication.
3. `need` / `operations`: bounded missing ranges with flow control. The receiver
   verifies shape, signature, grant, authority, causal dependencies, and
   per-kind limits before atomic inbox/projection apply.
4. `blob_manifest` / `blob_need` / `blob_chunk`: resumable, hash-verified,
   size-bounded transfer after the referencing operation is authorized.
5. `ack`: highest durable ranges, blob-manifest root, and rejected/quarantined
   IDs. Acknowledgement means durable local receipt, not socket receipt.
6. `presence` and stream frames: bounded events outside the durable frontier.

Anti-entropy runs at connection, after frontier change, and periodically while a
route remains open. Peers initiate and serve ranges symmetrically; no server
winner exists. Runners prefer direct runner links for bulk catch-up and do not
upload to the engine so another runner can download. If both independently
subscribe an optional engine backup, each syncs its own frontier with that peer.
The engine is not a bridge. A last-resort relay sees only encrypted frames and
cannot materialize, authorize, reorder as valid, or merge data.

The current protocol provides reusable payloads:
`shared/user-realtime-protocol.ts` defines bounded command envelopes and
idempotency keys; `solid/realtime-client-codec.ts` and `sync-engine/realtime.ts`
define snapshots, receipts, deltas, and stream frames. Wrap durable changes in
peer envelopes and split durable operations from streaming. The in-memory
`sync-engine/realtime-command-ledger.ts` cannot remain the receipt store;
authority runners persist receipts.

## Full-replica lifecycle and storage growth

### Admission and catch-up

A new or long-offline runner follows a declared state machine:

1. An owner-authorized peer signs its full-account membership and confirms the
   runner reports sufficient free space for the current projection, retained
   operation tail, complete blob set, and configured growth reserve.
2. The `joining` runner selects the newest compatible snapshot offered by any
   ready runner, downloads it in verified resumable chunks, and rebuilds its
   projection.
3. It requests the operation tail from that snapshot frontier and continuously
   follows new operations. If the log has compacted past its old checkpoint, it
   discards that obsolete checkpoint and uses a newer snapshot; no permanently
   missing range is tolerated.
4. It compares the complete content-addressed blob manifest, fetches missing
   blobs in bounded parallel chunks from any ready peers that advertise them,
   and resumes by chunk/hash after interruption. Blob source selection may
   balance peers but never changes authorization.
5. It verifies operation frontier, projection checksum/version, tombstone
   coverage, and blob-manifest root. Only then does it publish a signed `ready`
   receipt and become eligible as a normal executor or redundancy target.

Metadata becoming visible during `joining` does not imply full durability. The
UI shows operation and blob bytes remaining, oldest missing frontier, estimated
space, source peers, and errors. A joining runner can serve an explicitly
partial read-only view, but cannot be described as a full replica, satisfy a
redundancy acknowledgement, receive default execution, or trigger collection of
another peer's data.

A runner offline for months uses exactly this snapshot-plus-tail path; catch-up
does not require the engine and can be seeded from any ready runner over LAN,
VPN, removable encrypted transfer, or other authenticated peer transport. A
portable seed is a signed/encrypted transport optimization, not a distinct
backup format, and must revalidate hashes, signatures, grant state, and the live
tail before readiness.

### Capacity and retention

Full replicas intentionally make runner disk growth proportional to total
account history and attachments, not that runner's workload. The product must
show total logical bytes, physical deduplicated bytes, per-class growth, growth
rate, minimum free-space reserve, and each runner's complete/incomplete state.
Content hashes deduplicate identical attachments and snapshots; compression and
operation compaction reduce representation cost but not replica scope.

Runner blob LRU eviction, “download on open,” assignment-scoped history, and
silent quota skipping are forbidden for ready replicas. Capacity pressure pauses
admission of new large data before local disk exhaustion and surfaces a specific
action: add capacity, delete shared application data through a replicated
tombstone, or retire the runner. Retiring a runner first transfers all
unacknowledged local operations/blobs to another ready runner, records a signed
retirement, and then allows local cryptographic erase.

Log compaction is safe only when a compatible snapshot is durable on at least
two non-retiring ready runners and retained operations cover every frontier not
superseded by that snapshot. Permanently retired peers do not block compaction;
a returning retired device must enroll and bootstrap anew. Tombstone collection
uses acknowledged causal frontiers plus the repository's audit/retention policy,
never wall-clock age alone. Blob bytes are collected only after the referencing
metadata is tombstoned, safe frontiers prove every member observed the
tombstone, and no retained snapshot/reference needs them.

A successful local write is durable on its author and immediately enters every
reachable ready runner's outbound schedule. Until another runner durably
acknowledges the operation and referenced blobs, the UI labels it `local-only`
and identifies the author as the sole current copy. This replication interval
cannot be eliminated without blocking offline writes. It does not make a ready
runner a partial replica of prior state; it means its frontier has not yet
advanced to this new write. Operators may require two receipts before large
imports or before reporting the new frontier as single-failure redundant.

## Conflict policy

Entity conflict rules are normative and specified in
[convergence.md](convergence.md). They use causal/HLC registers for mergeable
metadata, remove-wins tombstones, immutable requests/events, and certified
single-writer execution streams; no SQL row or engine copy is a universal
winner.

## Session execution protocol

### Authority certificate

A session creation operation contains `(sessionId, runnerId, epoch = 0)` and the
target runner acknowledges it. The authority certificate binds:

```text
session ID + epoch + runner device key + previous epoch frontier + grant ID
```

The creator's valid grant and target acceptance establish epoch zero. For
reassignment, the current runner signs a handoff offer at a quiescent boundary;
the target signs acceptance. Any peer may retain/relay those records, but no
engine co-signature is required. The target writes epoch `n + 1` only after both
records are durable. The old runner fences itself before acknowledgement and can
never resume that epoch.

`agent_sessions.execution_generation`, restart handoff fields, generation checks
in `sync-engine/session-runtime.ts`, and update drain in
`runner/runner-update.ts` provide concepts to generalize. They do not yet
transfer authority because orchestration lives in the engine.

If the source cannot participate, Q Mush offers **Fork for recovery**. Any ready
runner already has the last verified transcript and starts a new session with
that frontier plus a visible source link. This is not takeover; when the old
runner returns, the original remains separate. Full replication prevents data
loss but cannot prove the unavailable process stopped external side effects.

### Local execution path

The runner hosts the coordinator, not only tools:

1. It durably accepts a create/continue/input request and emits a receipt.
2. It reads its full local projection and target-bound private vault envelope.
3. It runs the provider/model and agent loop locally, appending durable turn and
   message operations around external effects.
4. Its tool adapter directly invokes existing runner workspace/container/tool
   modules; no command bounces through an engine WebSocket.
5. It sends live deltas and committed operations directly to connected peers.
6. Every reachable runner ingests the operations and referenced blobs. An
   optional engine backup receives them only through its own peer subscription.

Migration extracts runtime-neutral agent/provider/domain pieces from
`sync-engine/session-agent-*.ts`, `sync-engine/session-launcher.ts`, and
`sync-engine/agent-model.ts` into `shared/`, then adds engine and runner host
adapters. `runner/` must not import `sync-engine/`.

### External side effects

Convergence cannot make arbitrary shell commands exactly once across a crash.
Authority provides at-most-one concurrent executor, with explicit write-ahead
recovery:

- persist `tool_started(callId, epoch, argumentsHash)` before dispatch;
- persist bounded output according to current policy;
- persist `tool_finished` after result;
- never blindly rerun an indeterminate side-effecting call after crash; surface
  it as interrupted; and
- use provider idempotency keys where supported without claiming universal
  exactly-once billing.

Exactly one executor is the architecture guarantee; exactly once for every
external system is not.

## Reconnection and convergence

When peers connect, they authenticate device/trust state, gossip revocations,
exchange operation/snapshot/blob frontiers, and apply missing control records
before dependent data. Operations apply in causal batches; executor output is
checked against its epoch. Unsupported kinds quarantine. Blob metadata may
render during joining, but a ready runner cannot retain a “missing attachment”
state. Projection uniqueness is repaired with domain rules rather than dropping
an operation because a SQL index rejects an intermediate state. Durable
acknowledgements advance readiness/compaction; ephemeral streams rebuild from
live connections.

No engine copy overwrites peer work. If an optional engine replica has a valid
concurrent register assignment, normal causal rules apply. If it has output from
an invalid executor or control data outside its key purpose, peers quarantine
it. Security-sensitive ambiguity fails closed.

## CRDT library decision

Use a small Q Mush domain operation layer initially, not a whole-database CRDT
or generic JSON document as the canonical model. Multi-writer data is mostly
registers, observed-remove sets, immutable events, and explicit single-writer
streams. Visible domain rules keep authority, full-replica completeness,
credential exclusion, tombstones, and relational projections reviewable.

Do not implement novel text CRDT algorithms. If character-level prompt editing
becomes required, adopt a mature CRDT behind the same operation boundary after a
reproducible browser/Bun/Vite/standalone spike. Automerge and Yjs are candidates
for that bounded use; cr-sqlite may be evaluated behind a projection adapter but
does not solve IndexedDB, execution authority, full blob transfer, or credential
separation. No such dependency belongs on the critical path without verified Bun
standalone compatibility, bundle/resource measurements, and an ADR.
