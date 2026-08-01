# Replication and execution authority

This document is normative detail for the
[local-first architecture](../local-first-architecture.md).

## Storage model

Each runner and the engine use SQLite. A browser profile uses IndexedDB. Both
hold the same logical layers:

1. **Inbox/outbox operation log:** immutable operations, verification state,
   source peer, and rejection reason. Local durable commit happens before an
   author reports success.
2. **Materialized projection:** query-friendly session, message, prompt,
   workspace, and public connection-summary records. On Bun peers this remains
   Drizzle/SQLite and preserves the existing tables in
   `shared/database/schema.ts` where practical. Browser projections use
   IndexedDB and shared codecs rather than running SQL in WebAssembly.
3. **Blob store:** attachments and large snapshots addressed by SHA-256, with
   authorization metadata in the log and bounded transfer outside operation
   envelopes.
4. **Control store:** device keys, grants, revocations, peer checkpoints,
   protocol versions, and credential-envelope metadata. It is not exposed by
   ordinary collection APIs.

SQLite rows are projections, not synchronization records. Replicating SQL
`UPDATE` statements or copying database files would couple peers to one schema,
lose causal intent, and make current partial unique indexes conflict during
multi-writer merge. Existing stores such as `sync-engine/prompt-store.ts` and
`sync-engine/session-store.ts` should write domain commands through one
transactional operation/projection boundary; they must not become a second
source of truth.

A transactionally maintained outbox avoids a dual-write window on Bun peers. The
browser writes its operation and projection in one IndexedDB transaction. A
background compactor may create a signed snapshot after all operations in its
frontier are durable; snapshots accelerate bootstrap but never invent authority.

### Operation envelope

The wire encoding should be a canonical, bounded binary envelope (canonical CBOR
is the default; canonical JSON is acceptable for the first read-only stage).
Conceptually:

```text
operationId: UUIDv7
schemaVersion: positive integer
kind: namespaced domain operation
scope: { userId, workspaceId }
author: { deviceId, keyId }
authorSequence: monotonic uint64
clock: { physicalMs, logical, deviceId }       # hybrid logical clock
parents: compact causal frontier / operation hashes
entity: { type, id }
payload: kind-specific value or blob refs
execution: { sessionId, epoch } | absent
signature: Ed25519 over canonical preceding fields
```

- `operationId` is the idempotency key. A unique `(deviceId, authorSequence)`
  also detects rollback, gaps, and equivocation.
- A hybrid logical clock (HLC) advances from the local durable clock and every
  received operation. The tuple `(physicalMs, logical, deviceId)` totally orders
  otherwise concurrent LWW register assignments without trusting synchronized
  wall clocks. Extreme forward jumps are quarantined and displayed as a device
  clock problem.
- `parents` carries enough causal frontier information to distinguish
  happened-before from concurrent writes. Peers exchange compact per-author
  ranges/checkpoints rather than sending a full vector in every large payload.
- The signature authenticates authorship and scope; it does not grant authority.
  The verifier also evaluates the grant and, for executor-owned operations, the
  epoch certificate.
- Unknown optional fields survive forwarding. An unknown operation kind is
  durably quarantined and advances no materialized state; it is never silently
  treated as a generic row patch.

Schema versions are operation-level. Migrations may rebuild projections from a
snapshot plus subsequent operations. Existing UUIDv7 generation in
`shared/ids.ts`, audit fields in `shared/database/audit-columns.ts`, and
soft-delete fields in `shared/database/schema.ts` remain the application-facing
identity and audit representation.

## Synchronization protocol

The protocol is transport-independent and lives in `shared/`. A WebSocket,
WebRTC data channel, or future relay carries the same frames:

1. `hello`: peer/device identity, signed nonce, protocol and app versions,
   authorized workspace grant IDs, maximum frame size, compression, and blob
   capabilities.
2. `frontier`: per-workspace operation ranges/checkpoints and latest compatible
   snapshot frontier. No private entity metadata appears before mutual auth.
3. `need` / `operations`: bounded missing ranges with flow control. The receiver
   verifies envelope shape, signature, grant, authority, causal dependencies,
   and per-kind limits before an atomic inbox/projection apply.
4. `blob_need` / `blob_chunk`: resumable, hash-verified and size-bounded
   transfer only after the referencing operation is authorized.
5. `ack`: highest durable ranges and rejected/quarantined IDs. An
   acknowledgement means durable local receipt, not merely socket receipt.
6. `presence` and stream frames: short-lived, bounded events explicitly outside
   the durable frontier.

Anti-entropy runs on connection and when a frontier changes. Each peer can send
and receive; no “server winner” exists. Relays may store opaque frames but do
not receive grants that let them materialize plaintext. Backpressure is per
workspace and per blob. Peer checkpoints permit safe log compaction only when a
snapshot is durable on the local runner and at least one other trusted durable
peer; revoked or permanently retired peers do not block compaction forever.
Tombstone retention must be measured by acknowledged causal frontier, never by
wall-clock age alone.

The current browser protocol already has useful shapes:
`shared/user-realtime-protocol.ts` defines bounded command envelopes with
command IDs and idempotency keys; `solid/realtime-client-codec.ts` and
`sync-engine/realtime.ts` define snapshots, command receipts, session deltas,
and tool stream frames. Preserve those domain payloads where possible, but wrap
durable changes in the peer envelope and split durable operations from ephemeral
streaming. The in-memory `sync-engine/realtime-command-ledger.ts` cannot be the
offline receipt store; its idempotency contract should become durable at the
session authority.

## Conflict policy by entity

“LWW” means an HLC register with causal context and a device-ID tie-break—not
`updatedAt`. IDs, not unique display names, define identity.

- **User and control records:** the engine issues users, runner registrations,
  grants, revocations, credential summaries, and defaults. Peers can report
  presence but cannot mint, widen, transfer, or undo these records. Credential
  secrets use the separate non-CRDT envelope channel.
- **Workspaces:** creation has an immutable UUIDv7 ID; name is LWW; delete is a
  remove-wins tombstone. Concurrent same names remain distinct and display a
  stable disambiguator. Default workspace is a user LWW register; if its target
  is gone, select the active workspace with lowest creation clock/ID and emit a
  repair.
- **Prompt bank:** prompt ID is immutable; name and body are separate LWW
  registers; delete is remove-wins. Different-field edits combine. Concurrent
  body losers remain conflict revisions for compare/restore. Same normalized
  names are disambiguated, not rejected. The existing prompt `revision` becomes
  a local projection revision, not a distributed clock.
- **Session creation/configuration:** creation is immutable and names an
  executor. Title is LWW. Model, tools, directory, provider, and runner changes
  are requests serialized or rejected by the executor at an epoch boundary; they
  never patch a running row concurrently. Two offline creates are two sessions.
- **Session assignment/epoch:** one writer with a monotonically increasing epoch
  and signed handoff. No timeout election. Stale output is rejected; unclean
  recovery forks.
- **Canonical messages/turns/status/usage/tool results:** append-only and
  executor-owned for the certified epoch. IDs and per-epoch ordinals are
  immutable. Duplicate operations dedupe. Two values at one ordinal indicate
  equivocation and are quarantined. Usage and compaction are serialized by the
  executor rather than merged numerically.
- **Pending inputs, answers, stop, and steer:** any granted user device creates
  an immutable request keyed by `clientRequestId`; cancel is a remove-wins
  tombstone; the executor writes one terminal receipt. It accepts ready requests
  in deterministic `(causal readiness, HLC, request ID)` order and assigns queue
  sequence. Same idempotency key with another payload hash is rejected. First
  accepted question answer wins; stop/steer are not effective before receipt.
- **Attachments:** immutable SHA-256-addressed blobs plus metadata. Equal hashes
  dedupe. A metadata tombstone removes visibility; bytes are collected only
  after authorized frontier acknowledgement and existing size/type checks.
- **Presence and live deltas:** ephemeral, never part of durable convergence.
  Final messages/usage arrive as executor operations.
- **Browser drafts/preferences:** profile-local unless a future explicit
  preference entity is added. Drafts are distinct from pending input.

### Why not a CRDT for the whole transcript?

A transcript reflects an external model call and filesystem-affecting tools. Two
independent “valid” assistant branches cannot be interleaved safely: tool call
IDs, replay order, provider charges, and side effects depend on one causal turn.
`shared/session-message-order.ts` currently sorts messages by creation time and
ID, while `shared/database/schema.ts` already records turns and one active turn.
The target strengthens this into an executor sequence. CRDTs are used around the
execution boundary—inputs, user metadata, prompt fields—not to conceal split
brain.

## Session execution protocol

### Authority certificate

A session creation operation contains `(sessionId, runnerId, epoch = 0)` and the
runner acknowledges it. An authority certificate binds:

```text
session ID + epoch + runner device key + previous epoch frontier + grant ID
```

For initial creation, the creator's valid workspace grant and target runner's
acceptance establish epoch zero. For reassignment, the current runner signs a
handoff offer at a quiescent boundary; the target signs acceptance; the engine
may co-sign and archive it while online but is not required. The target can
write epoch `n + 1` only after both records are durable. The old runner fences
itself before acknowledging handoff and can never resume that epoch.

Current `agent_sessions.execution_generation`, restart handoff fields, and the
one-active-turn index in `shared/database/schema.ts`, plus generation checks in
`sync-engine/session-runtime.ts` and the runner update drain in
`runner/runner-update.ts`, provide concepts to generalize. They do not yet
transfer authority because orchestration still lives in the engine.

If the source cannot participate, Q Mush offers **Fork for recovery**. The new
runner starts a new session with the last verified transcript frontier and a
visible link to the unreachable source. This is intentionally not takeover; when
the old runner returns, its original session remains a separate history. A
future quorum/fencing service could add forced takeover, but it is not part of
this design.

### Local execution path

To remove the engine from the hot path, the runner must host the coordinator,
not just tools:

1. The runner durably accepts a create/continue/input request and emits a
   receipt.
2. It reads the local session projection and private credential vault.
3. It runs the provider/model and agent loop locally, appending durable turn and
   message operations around external side effects.
4. Its tool adapter invokes the existing `runner/runner-command.ts` and related
   workspace/container modules directly; local execution does not bounce a
   command through a WebSocket.
5. It publishes ephemeral deltas to connected tabs/peers and durable operations
   after commit.
6. Other peers materialize the same transcript and relay it to the engine when
   any route returns.

Today these responsibilities are split between engine modules such as
`sync-engine/session-agent-loop.ts`, `sync-engine/session-agent-runtime.ts`,
`sync-engine/session-launcher.ts`, and `sync-engine/agent-model.ts`, and runner
modules such as `runner/runner-command.ts`. The migration should extract
runtime-neutral agent/provider/domain pieces into `shared/` and add host
adapters rather than allowing `runner/` to import `sync-engine/`, which would
violate the boundary enforced by `eslint.config.ts`.

### External side effects

Operation convergence cannot make an arbitrary shell command exactly once across
a crash. The authority provides **at-most-one concurrent executor**, and its
write-ahead tool record provides explicit recovery semantics:

- persist `tool_started(callId, epoch, arguments hash)` before dispatch;
- persist streamed output as bounded ephemeral/durable chunks according to the
  current tool policy;
- persist `tool_finished` after result;
- after a crash, never blindly rerun an indeterminate side-effecting call;
  surface it as interrupted, as current restart recovery already does for tool
  conversations in session store logic;
- use idempotency keys for provider operations that support them, but do not
  claim universal exactly-once provider billing.

“Exactly one executor” is the architectural guarantee. “Exactly once every
external effect” is not achievable without cooperation from each external
system.

## Reconnection and convergence

When the engine or another peer returns:

1. Mutual device authentication and current grant/revocation checks run first.
2. Each side exchanges workspace frontiers and compatible snapshot offers.
3. Missing control records are applied before data operations. A revocation may
   immediately close a channel and suppress later unauthorized ranges.
4. Operations are validated and applied in causal batches. Executor-owned data
   is checked against the epoch certificate. Unsupported kinds are quarantined.
5. Missing blobs transfer by hash. Metadata may converge before bytes and shows
   a clear “attachment not present on this peer” state.
6. Materialized unique-name/default constraints are repaired using the domain
   rules above; no operation is dropped merely because SQL's current partial
   index rejects a transient projection.
7. Durable acknowledgements advance compaction frontiers. Ephemeral presence and
   stream state are rebuilt from current connections, never replayed.

The engine does not overwrite offline work. If it holds a conflicting valid LWW
assignment, the HLC/causal rule applies. If it holds output from an invalid
executor, that output is quarantined. Security-sensitive control-plane conflicts
always fail closed.

## CRDT library decision

Use a small Q Mush domain operation layer for the first implementation, not a
whole-database CRDT and not a general JSON document as the canonical model. The
data requiring multi-writer merge is mostly registers, observed-remove sets,
immutable events, and explicit single-writer streams. Encoding those rules
visibly keeps session authority, workspace authorization, tombstones, and
relational projections reviewable.

This does **not** mean writing novel text CRDT algorithms. If concurrent
character-level prompt editing becomes a product requirement, adopt a mature
CRDT for the prompt body behind the same domain operation boundary after a
spike.

Research as of this design:

- [Automerge concepts](https://automerge.org/docs/reference/concepts/) describe
  a JSON-like document with history, deterministic merge, a compact format, and
  a transport-agnostic per-document sync protocol. Its
  [initialization guide](https://automerge.org/docs/reference/library-initialization/)
  documents modern browsers, Node, and Vite/WebAssembly setup, but does not name
  Bun. It is a good spike candidate for prompt bodies or for replacing the
  domain transport later; compatibility with Bun's standalone `compile` output,
  bundle size, memory, CSP, and the project's Vite configuration is
  **unverified**.
- [Yjs](https://docs.yjs.dev/) is network-agnostic, converges updates regardless
  of delivery order, and has WebRTC/WebSocket/IndexedDB providers. It is
  optimized for shared document/editor state. Q Mush has no collaborative rich
  text editor today, and no official source found in this research explicitly
  verifies Bun or standalone executable compatibility. It is therefore a
  prompt-editor candidate, not the session database.
- [cr-sqlite](https://vlcn.io/docs/cr-sqlite/intro) is a runtime-loadable SQLite
  extension for merging independently written databases. That is attractive, but
  it would not by itself encode executor authority or secret filtering, browsers
  would still need another store, and it expands the standalone cross-platform
  binary surface. Bun documents `Database.loadExtension`, but notes special
  SQLite requirements on macOS. Exact compatibility with Bun 1.3.14, Drizzle
  migrations, all runner targets, and compiled executables is **unverified**. Do
  not put it on the critical path.

Stage 2 includes reproducible Automerge/Yjs/Bun experiments and records the
result in an architecture decision record before adding either dependency. The
operation protocol is intentionally independent of that result.
