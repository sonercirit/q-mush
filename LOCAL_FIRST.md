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
  Checkpoints therefore grow linearly with replay history and the `applied`
  identity index. With 2,000 sequential operations and a minimal
  `{ value: "x" }` payload, a `readonly string[]` projection containing each
  operation ID, `entity.type: "workspaces"`, `kind: "workspace.name.set"`, and
  identifiers `writerId: "a"`, `accountId: "a"`, `entity.id: "w"`, and operation
  IDs `a-<sequence>`, plain JSON with decimal bigint strings measures 2,099,540
  bytes (1,049.77 bytes/operation, 2.002 MiB total); the production tagged
  checkpoint encoding measures 2,783,735 bytes (1,391.87 bytes/operation, 2.655
  MiB total). Checkpoint decoding rejects repeated replay or pending
  operation-ID or writer-sequence identities, including byte-identical
  duplicates, and rejects negative sequence, parent, and frontier values while
  preserving signed bigint operation payloads. Sizes use bytes per operation and
  binary MiB (1 MiB = 1,048,576 bytes). No safe compaction exists yet because a
  local replica cannot know whether a peer may later send a valid earlier-clock
  operation. The reachable authenticated route therefore fails closed at 16 KiB
  per encoded envelope, 2,000 stored operations per owner/partition, or a 4 MiB
  encoded checkpoint (HTTP 507 for either history capacity). These validation
  limits apply after the synchronization route has fully buffered and parsed its
  JSON body; stage 2 does not impose a route-level request-byte bound. Reads
  likewise have no route-level response-byte bound: the fixed 256-envelope page
  and 16 KiB encoded-envelope limit permit up to 4 MiB of envelope string
  contents. JSON string escaping can nearly double that size in the worst case,
  so the server may materialize an approximately 8 MiB response body for one
  full page, including framing. A separate byte cap would require either
  measuring encoded rows while paging or serializing twice; the existing
  deterministic count and per-envelope caps are retained for this temporary
  protocol instead. With 4 KiB payloads the 4 MiB is reached after about 300
  operations, before the nominal 2,000-envelope cap, and this wedge is
  unrecoverable until the stability protocol permits compaction. These are
  temporary safety limits, not compaction. Reviewer in-memory single-operation
  measurements grew from 258 KB/9.8 ms at 200 operations through 1.03 MB/39.1 ms
  at 800 and 4.14 MB/134.4 ms at 3,200; 20,000 operations produced a 25.1 MB
  checkpoint whose decode alone took 564 ms. Bounded compaction remains deferred
  to stage 2 anti-entropy and durable subscriber receipts, which can establish a
  stable boundary. Writer identity is currently forced to the authenticated
  account ID; whether device keys should introduce per-device writer IDs remains
  open for that later slice. Identity fingerprints remain plain enumerable
  checkpoint data: live state stores the serializable balanced identity tree,
  and checkpoint encoding (or `materializeApplied`) creates the flat record on
  demand. Sequential steady-state admission is expected O(log n) per operation
  and O(n log n) overall, rather than repeatedly materializing O(n) records.
  Unready operations maintain a per-state persistent identity treap for
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
  `undefined` is rejected. Tagged bigint checkpoint encodings are injective:
  decimal `0` is accepted, while non-canonical `-0` is rejected. The checkpoint
  codec currently supports only `readonly string[]` projections; its exported
  types enforce that restriction until a caller-supplied projection codec is
  introduced. The operation envelope, clock, and entity require the codec's
  exact key sets at admission. Values must be reference-free trees: shared
  object references and cycles are rejected. Operation values accept primitives,
  arrays, plain string-keyed objects, and valid Dates; other object prototypes
  and symbol keys are rejected. Every validated or decoded operation snapshot is
  transitively frozen before retention, including payload, parents, clock, and
  entity. Reducers receive these frozen inputs and must be pure with respect to
  operations: build projections without mutating an operation or anything
  reachable from it. The auth bearer-token `sessions`, encrypted
  `provider_credentials`, and setup-token-bearing `runners` tables are
  deliberately absent from operation replication because ordinary frames contain
  no secrets. The remaining closed allow-list was audited against schema
  columns: none stores credentials, authentication tokens, password material, or
  encryption keys. Blob lookup early hit. Solid selects its host from page
  metadata; both runner and authenticated migration-engine handlers serve
  bounded, read-only active views labeled with origin and completeness.
  Sensitive export tables use explicit public-column allow-lists; blobs download
  separately/resumably. Engine blob GETs are stateless and read-only: they
  derive digests from owner-scoped attachment columns, requiring no export
  priming, duplicated blob table, or process cache. Engine active views rewrite
  inline attachments to the digest references Solid consumes; runner views use
  replicated references and its blob store. Runner catch-up is
  background/non-fatal; its loopback app uses an ephemeral collision-free port
  unless configured. Stage-2 operation durability now stores owner-scoped,
  encoded envelopes with operation-ID and writer-sequence equivocation checks
  scoped per partition, matching each partition’s independent writer sequence
  space, serves bounded ranges after a causal frontier, and atomically replaces
  one encoded checkpoint per owner and partition. Engine intake transactionally
  admits a bounded batch, drives the shared `applyOperation` reducer path from a
  strictly decoded checkpoint, and persists the complete projection, frontier,
  pending, identity, and replay state; duplicates no-op and equivocation aborts
  and rolls back the complete batch. An order-preserving, arbitrary-size decimal
  sequence key backs the owner/partition/writer range index; the store returns
  bounded missing-envelope pages in deterministic writer/sequence order without
  SQLite integer casts. The frontier OR predicate uses that ordered index to
  avoid a temporary sort, but SQLite scans the complete matching owner/partition
  index prefix: read work is O(history), not a bounded per-writer index range.
  Client-caused intake scope and batch-bound failures are protocol-invalid
  errors (HTTP 400), while history/checkpoint capacity is HTTP 507. The
  authenticated, owner-scoped endpoint accepts strict write `POST` bodies
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
