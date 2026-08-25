# Local-first architecture memory

- Stage-1 replicas accept only schema-validated, entity-counted, checksum-bound
  account inventories; readiness rechecks manifests/blobs, reserves SQLite/WAL
  plus incoming/install space. Paged exports use keyset cursors and cache exact
  per-table count/max-audit-time revisions until SQLite change counters move;
  hard deletes are forbidden, so inserts cannot hide behind a cursor while
  preserving that revision. Presence does not advance audit time. Revision
  changes retry indefinitely with capped backoff and log each restart's count,
  elapsed time, and revisions. Stage 1 catches up only at runner startup;
  continuous post-ready synchronization is required by stage 2. Blob lookup
  early hit. Solid selects its host from page metadata; both runner and
  authenticated migration-engine handlers serve bounded, read-only active views
  labeled with origin and completeness. Sensitive export tables use explicit
  public-column allow-lists; blobs download separately/resumably. Engine blob
  GETs are stateless and read-only: they derive digests from owner-scoped
  attachment columns, requiring no export priming, duplicated blob table, or
  process cache. Engine active views rewrite inline attachments to the digest
  references Solid consumes; runner views use replicated references and its blob
  store. Runner catch-up is background/non-fatal; its loopback app uses an
  ephemeral collision-free port unless configured. Physical pairing is
  transcript-bound, five-minute, one-use/rate-limited, constant-time checked;
  the browser grant and pairing transcript are never logged.

## Operational rules

- Export revision caches invalidate on both same-connection total changes and
  cross-connection SQLite data-version changes. Every exported owner partition
  has an `(owner, id)` index so continuation pages remain keyset-bounded.
- Runner removal deterministically fences malformed cyclic session lineages
  rather than allowing one cycle to abort reassignment of every valid session.
  The unauthenticated `/` and `/app` shell provides the physical pairing UI;
  replica APIs remain browser-grant protected.
