# Local-first architecture memory

- Stage-1 replicas accept only schema-validated, entity-counted, checksum-bound
  account inventories; readiness rechecks manifests/blobs, reserves SQLite/WAL
  plus incoming/install space. Paged exports use keyset cursors and cache exact
  per-table count/max-audit-time revisions until SQLite change counters move;
  hard deletes are forbidden, so inserts cannot hide behind a cursor while
  preserving that revision. Presence does not advance audit time. Revision
  changes retry indefinitely with capped backoff and log each restart's count,
  elapsed time, and revisions. Stage 1 catches up only at runner startup;
  continuous post-ready synchronization is required by stage 2. The stage-2
  runtime-neutral operation core derives partitions from a closed entity
  allow-list, validates operation values, binds each HLC writer to its envelope,
  requires a writer's HLC to strictly advance with sequence across all state,
  and rejects remote HLCs more than five minutes in either direction on
  authenticated intake. Newly ready operations retain the complete
  post-checkpoint replay set and order all applied operations by HLC
  `(physicalMs, logical, writerId)`, so non-commutative updates converge across
  arrival order. Replay metadata is a mandatory part of every durable checkpoint
  and uses structural sharing in memory. An open question is how offline clients
  can sync queued operations: the current five-minute drift check also rejects
  clocks more than five minutes in the past, so a client offline longer than
  that cannot submit its queue. Encoding flattens replay history and both
  encoding and decoding are depth-independent, without dropping history.
  Checkpoints grow linearly with replay and applied identity history. A measured
  2,000-operation single-workspace stream using the production typed reducer and
  codec produced 2,659,611 bytes (1,329.81 B/op, 2.536 MiB); apply took 566.5 ms
  and encoding 52.4 ms on the development runner. Checkpoint decoding rejects
  repeated replay or pending operation-ID or writer-sequence identities,
  including byte-identical duplicates, and rejects negative sequence, parent,
  and frontier values while preserving signed bigint operation payloads.
  Stability compaction folds replay prefixes proven safe by frontier, drift, and
  pending-clock bounds. The route fails closed at 16 KiB per encoded envelope,
  2,000 retained replay-plus-pending operations per owner/partition, or a 4 MiB
  checkpoint (HTTP 507). Limits apply after buffering/parsing JSON; stage 2 has
  no request-byte cap. Reads allow 256 envelopes × 16 KiB; escaping can double
  JSON size. A separate cap needs paging measurement or double serialization.
  With 4 KiB payloads an uncompacted checkpoint reaches 4 MiB near 300
  operations; folding resolves it once entries age and become covered. Envelope
  deletion remains deferred until subscriber receipts can bound replicated
  scope. Writer identity is currently forced to the authenticated account ID;
  whether device keys should introduce per-device writer IDs remains open for
  that later slice. Identity fingerprints remain plain enumerable checkpoint
  data: live state stores the serializable balanced identity tree; checkpoint
  encoding (or `materializeApplied`) creates the flat record on demand.
  Steady-state admission is expected O(log n) per operation and O(n log n)
  overall. Unready operations maintain a per-state identity treap for
  incremental O(log n) checks and bounded admission; operation intake and
  synchronization batches share `MAX_OPERATION_BATCH_SIZE` (512), after which
  admission fails rather than silently wedging, while a ready dependency may
  enter a full buffer to drain it; operation-ID and writer-sequence equivocation
  is rejected. Durable checkpoints consist of `frontier`, `pending`,
  `projection`, `applied`, `replayHead`, `replayCount`, `replayLastClock`,
  `baseProjection`, and `baseFrontier`; none of the replay fields is optional.
  Decoding fails closed unless replay count/head clock, global canonical clock
  order, per-writer sequence contiguity from the base frontier, replay-parent
  coverage by the final derived frontier, own-writer parents strictly below
  their operation sequence in replay and pending state, derived frontier,
  applied identities, and pending identities are mutually consistent, including
  pending-against-pending operation-ID and writer-sequence checks. HLC
  components are non-negative safe integers. Frontier/parent access is
  own-property-safe, including `__proto__`; canonical identity explicitly
  preserves `undefined` object-property and dense array-element presence, while
  operation validation rejects sparse arrays, negative zero, extra array/Date
  own properties, non-enumerable or symbol object properties, and every accessor
  property. Admission validates the original descriptor shape while producing a
  plain deep snapshot from each data descriptor exactly once. Creation returns
  that mutable snapshot, while every apply admission independently revalidates
  and resnapshots its candidate, including re-deriving the declared partition
  from the closed entity allow-list. Intake first snapshots the caller object,
  then apply re-walks only that plain copy, so the caller is still read once and
  fingerprints, reduction, persistence, and checkpoint encoding use validated
  plain data. Entity `workspaceId` must be omitted or a string; explicit
  `undefined` is rejected. Tagged bigint encoding rejects noncanonical forms.
  Checkpoint callers supply the projection codec; production paths use one typed
  codec validating exact structures, canonical ordering, metadata, conflicts,
  safe IDs, and defaults. The operation envelope, clock, and entity require the
  codec's exact key sets at admission. Values must be reference-free trees:
  shared object references and cycles are rejected. Operation values accept
  primitives, arrays, plain string-keyed objects, and valid Dates; other object
  prototypes and symbol keys are rejected. Every validated or decoded operation
  snapshot is transitively frozen before retention, including payload, parents,
  clock, and entity. Each reducer invocation receives a separate transitively
  frozen deep copy rebuilt from that pristine retained snapshot; retained
  snapshots are never exposed to reducers. Reducers must remain pure with
  respect to their operation input's object properties, while internal-slot
  mutation such as `Date.setTime()` can affect only the invocation's defensive
  copy and cannot corrupt fingerprints, replay history, or later encoding. The
  auth bearer-token `sessions`, encrypted `provider_credentials`, and
  setup-token-bearing `runners` tables are deliberately absent from operation
  replication because ordinary frames contain no secrets. The remaining closed
  allow-list was audited against schema columns: none stores credentials,
  authentication tokens, password material, or encryption keys. Blob lookup
  early hit. Solid selects its host from page metadata; both runner and
  authenticated migration-engine handlers serve bounded, read-only active views
  labeled with origin and completeness. Sensitive export tables use explicit
  public-column allow-lists; blobs download separately/resumably. Engine blob
  GETs are stateless and read-only: they derive digests from owner-scoped
  attachment columns, requiring no export priming, duplicated blob table, or
  process cache. Engine active views rewrite inline attachments to the digest
  references Solid consumes; runner views use replicated references and its blob
  store. Runner catch-up is background/non-fatal; its loopback app uses an
  ephemeral collision-free port unless configured. Stage-2 operation durability
  now stores owner-scoped, encoded envelopes with operation-ID and
  writer-sequence equivocation checks scoped per partition, matching each
  partition’s independent writer sequence space, serves bounded ranges after a
  causal frontier, and atomically replaces one encoded checkpoint per owner and
  partition. Engine intake transactionally admits a bounded batch, drives the
  shared `applyOperation` reducer path from a strictly decoded checkpoint, and
  persists the complete projection, frontier, pending, identity, and replay
  state; duplicates no-op and equivocation aborts and rolls back the complete
  batch. An order-preserving, arbitrary-size decimal sequence key backs the
  owner/partition/writer range index; the store returns bounded missing-envelope
  pages in deterministic writer/sequence order without SQLite integer casts. The
  frontier OR predicate uses that ordered index to avoid a temporary sort, but
  SQLite scans the complete matching owner/partition index prefix: read work is
  O(history), not a bounded per-writer index range. Client-caused intake scope
  and batch-bound failures are protocol-invalid errors (HTTP 400), while
  history/checkpoint capacity is HTTP 507. The authenticated, owner-scoped
  endpoint accepts strict write `POST` bodies
  `{ ownerId, partition, envelopes }` (at most 512) and read `PUT` bodies
  `{ ownerId, partition, frontier }`; reads return at most 256 encoded envelopes
  plus `hasMore` for resume and anti-entropy. Read frontiers fail closed above
  512 writers or 16 KiB for either a writer ID or decimal sequence component.
  Writes return only the decimal-string frontier and duplicate replays remain
  acknowledged even when history is full. Intake decodes loaded checkpoints
  once, persists validated successors, and serves stored envelope strings
  without a decode/re-encode pass. Complete checkpoint derivation remains
  O(history) on the single shared SQLite connection, and applying each batch
  candidate walks that history, so request work is O(batch × history) and
  serializes every other server write. One-operation measurements were 7 ms at
  100 operations, 27 ms at 500, 46 ms at 1,000, 70 ms at 1,500, and 89 ms at
  2,000; measured 200-operation batches grew 87–188 ms, one operation at 1,990
  took 96 ms, and the 2,000-operation checkpoint was 2,661,057 bytes (1,330
  B/op), bounding throughput before the history cap. Every envelope binds both
  `entity.accountId` and `writerId` to the authenticated account. Physical
  pairing is transcript-bound, five-minute, one-use/rate-limited, constant-time
  checked; the browser grant and pairing transcript are never logged.

## Typed entity projection

- Shared intake has a closed kind/entity/payload registry admitting only
  workspace create/name/delete, prompt create/name/body/delete, and user
  default-workspace writes. Unknown kinds/entities, malformed payloads, and all
  session operations fail closed. User-register entities must identify their
  account. Synchronization parses sequence values only after a string type
  check. Projection uses immutable create identity, LWW fields, remove-wins
  deletion, canonical prompt conflicts, causal discard, and default repair.
- No old production string checkpoint can exist: there is no local producer,
  engine checkpoints need non-empty POST intake, the runner outbox is empty, and
  runner checkpoints need non-empty pull pages. No data or database migration is
  required; stale/foreign blobs fail closed and need operator rebuild.
- Losing prompt bodies grow O(concurrent writers) across folds, bounded only by
  the fail-closed 4 MiB checkpoint cap. Current one-writer-per-account admission
  prevents such concurrency; conflict retirement or a tighter bound remains
  open.

## Operation stability compaction

- Checkpoints now carry `stableClock`; decoding accepts the legacy exact
  nine-field form as unstable and the exact ten-field form, while rejecting
  clocks inconsistent with the folded base, replay, or pending set. The engine
  folds only a clock-ordered replay prefix at/below every frontier writer's
  latest operation clock, with fully folded writers conservatively represented
  by the prior `stableClock`; strictly before every pending clock; and with
  `physicalMs < now - 5 minutes`. Subtracting one from the integral drift cutoff
  makes that last strict condition an inclusive HLC cap. Intake's strict
  per-writer sequence/clock advance and authenticated drift bound ensure future
  admissions are strictly above the result. Retained replay and pending clocks
  are likewise strictly above it. A dormant fully folded writer can therefore
  pin stability indefinitely; whether future device writer identity needs a
  retirement protocol remains open. Engine wall time is not monotonic-clamped:
  after a backward step, a newly drift-valid operation may still be at/below the
  prior stable clock and permanently stall its writer head; monotonic engine
  admission time remains an open requirement.
- The engine persists JSON `stable_clock` and decimal-string `stable_frontier`
  columns beside the checkpoint and publishes them on pull pages without blob
  decoding. A runner folds against the published clock only after its applied
  frontier covers the published frontier; this prevents an early bootstrap page
  from folding before a later writer's old-clock page arrives. Local writer and
  pending caps still apply. Null, uncovered, or no-op runner boundaries are
  rejected before opening a write transaction, preserving empty-page idle reads.
  Request-partition scope is validated first; envelope identities are then
  pre-screened against durable rows before core admission on both sides, so
  folded duplicates acknowledge without quarantine and fingerprint mismatches
  conflict. Engine drift checks happen only after this screen, fixing retries of
  acknowledged operations older than five minutes.
- The 2,000-operation limit now bounds retained replay plus pending work, not
  total envelope rows; the 4 MiB bound applies after attempted folding. This
  unwedges representation growth while immutable envelope rows intentionally
  continue growing with account history. Durable subscriber receipts remain
  deferred: they become necessary when scope compaction actually deletes those
  rows (and then require the documented two eligible durable replicas), not for
  this checkpoint representation compaction.

## Operational rules

- Export revision caches invalidate on both same-connection total changes and
  cross-connection SQLite data-version changes. Every exported owner partition
  has an `(owner, id)` index so continuation pages remain keyset-bounded.
- Runner removal deterministically fences malformed cyclic session lineages
  rather than allowing one cycle to abort reassignment of every valid session.
  The unauthenticated `/` and `/app` shell provides the physical pairing UI;
  replica APIs remain browser-grant protected. Unlike the engine active view,
  the runner checks that grant before method handling, so an unpaired non-GET
  `/api/local/*` request deliberately returns 401 rather than revealing 405.
- Runner operation replicas keep immutable encoded envelopes plus acceptance,
  source, rejection, and outbox metadata in the per-account SQLite. `accepted`
  means schema/intake admission, not cryptographic verification. Valid prefix
  log/projection/checkpoint writes share one transaction. Because the engine
  already used the same intake core, any malformed envelope or decoded remote
  intake rejection indicates corruption or version disagreement: the runner
  records it idempotently in a separate quarantine table using its real
  operation/writer/sequence identity, or a SHA-256 envelope identity when it
  cannot decode one, and durably stalls that partition. The accepted prefix is
  committed, the checkpoint/pull frontier never passes the rejected identity,
  and later page entries are neither accepted nor retained pending. Polling
  continues at capped failure backoff, logs the stall, and still synchronizes
  the other partition and local outbox. Repeated delivery is a no-op, preventing
  quarantine growth. Genuine storage failures still roll back the whole batch.
  Runner checkpoints use the shared 4 MiB encoded bound; overflow follows the
  same durable partition-stall path rather than growing without limit. Local
  producers additionally fail before durable queueing when an encoded envelope
  exceeds the shared 16 KiB engine intake bound; the engine retains its route
  check as defense in depth. An operator inspects/exports quarantine rows,
  repairs the engine or updates the runner, then rebuilds the replica from its
  checkpoint; there is intentionally no skip frontier or automatic re-admission.
  Local outbox HTTP 400 batch rejections are fail-closed with per-writer
  head-of-line stalling. The runner isolates a rejected batch singly in
  writer-sequence order and stops that writer at its first rejected envelope:
  successors remain ordinary durable pending rows, are neither pushed nor
  acknowledged, and cannot fill the engine's causal pending buffer. Other
  writers can continue independently; today writer identity is the account, so a
  permanent head poison blocks that partition's complete local outbox. Each
  later cycle retries only the stalled writer head before considering its
  successors. A successful head retry atomically clears its stall/pending state,
  then the queued suffix resumes in order; every acknowledged local operation
  has therefore reached engine state that can eventually apply it. Pull and the
  other partition remain unaffected. Stall state exposes the head operation,
  writer, bounded rejection reason, and exact queued-behind depth; cycle errors
  report at most five identities plus total stall and queued counts. HTTP
  rejection text is whitespace-normalized and bounded to its first 400
  characters before entering the transport error and durable stall reason. Any
  partition pull failure, pull stall, outbox stall, or transport failure makes
  the cycle fail for one bounded logged message and capped exponential backoff
  even when its peer succeeds; successful peer work remains committed. HTTP 507,
  403, and transport failures stay pending without classification or set-aside.
  In particular, 403 may be transient and never causes a tight retry loop.
  Operators repair the head envelope/clock, engine policy, or runner version,
  then rebuild while queued local rows remain durable; there is no skip/delete
  recovery path because preservation is safer than silent divergence. A
  permanently stalled outbox deliberately pins the overall cycle in failure
  backoff, so healthy-partition pull latency remains at the 30-second cap
  indefinitely; per-partition backoff is deferred. Synchronization starts only
  from the WebSocket operational/ready callback, aborts on disconnect, and
  restarts after the next ready handshake. It pushes up to 512 pending rows and
  pulls 256-row pages until `hasMore` clears. Empty pages do not open write
  transactions. Successful cycles poll every 5 seconds with ±20% jitter (slower
  than the former 1-second herd); failures use 1-second exponential backoff
  capped at 30 seconds and success resets it. Shutdown aborts requests. The HTTP
  operation route accepts the native runner bearer token only with owner alias
  `self`, avoiding account identity in the runner protocol; simultaneous browser
  and runner authentication deliberately uses runner identity/`self` alias
  semantics. No runner-local command producer exists yet; which command first
  emits local operations remains open. A producer also cannot currently
  construct an admissible writer: intake requires
  `writerId === entity.accountId ===` the authenticated user UUID, while the
  runner knows only origin and bearer token. Until an identity plane supplies
  that UUID (or intake introduces a sound runner writer mapping), a future
  runner-produced operation would receive 403 forever; retained outbox data and
  capped backoff prevent loss and a tight livelock but do not make it
  synchronizable.
