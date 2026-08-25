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
  allow-list, validates operation values, rejects excessively future HLCs, and
  uses contiguous per-writer sequences with causal frontiers. Newly ready
  operations retain the complete post-checkpoint replay set and order all
  applied operations by HLC `(physicalMs, logical, writerId)`, so
  non-commutative updates converge across arrival order. Replay metadata is a
  mandatory part of every durable checkpoint and uses structural sharing.
  Checkpoints therefore grow linearly with replay history and the `applied`
  identity index. With 2,000 sequential operations and a minimal
  `{ value: "x" }` payload and identifiers `writerId: "a"`, `accountId: "a"`,
  `entity.id: "w"`, and operation IDs `a-<sequence>`, plain JSON with decimal
  bigint strings measures 2,099,540 bytes (1,049.77 bytes/operation, 2.002 MiB
  total); the production tagged checkpoint encoding measures 2,783,735 bytes
  (1,391.87 bytes/operation, 2.655 MiB total). Sizes use bytes per operation and
  binary MiB (1 MiB = 1,048,576 bytes). No safe compaction exists yet because a
  local replica cannot know whether a peer may later send a valid earlier-clock
  operation. Unbounded history is an explicit known gap; bounded compaction is
  deferred to stage 2 anti-entropy and durable subscriber receipts, which can
  establish a stable boundary. Identity fingerprints are plain enumerable
  checkpoint data, while sequential steady-state admission remains amortized
  linear overall. Unready operations have indexed identity checks and bounded
  admission (512 entries, after which admission fails rather than silently
  wedging), while a ready dependency may enter a full buffer to drain it;
  operation-ID and writer-sequence equivocation is rejected. Durable checkpoints
  consist of `frontier`, `pending`, `projection`, `applied`, `replayHead`,
  `replayCount`, `replayLastClock`, `baseProjection`, and `baseFrontier`; none
  of the replay fields is optional. Operation values accept primitives, arrays,
  plain string-keyed objects, and valid Dates; other object prototypes, symbol
  keys, and cycles are rejected. The auth bearer-token `sessions`, encrypted
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
  unless configured. Physical pairing is transcript-bound, five-minute,
  one-use/rate-limited, constant-time checked; the browser grant and pairing
  transcript are never logged.

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
