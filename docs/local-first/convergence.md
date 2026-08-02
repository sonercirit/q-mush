# Convergence rules

This document is normative detail for the
[local-first architecture](../local-first-architecture.md). Operation, tier, and
full-runner mechanics are specified in [replication.md](replication.md).

“LWW” means an HLC register with causal context and device-ID tie-break, never
`updatedAt`. IDs—not unique display names—define identity. These rules apply to
runner replicas and the readable engine projection for its entitled partition.
The engine is not a universal winner. Solid clients submit commands and refetch
materialized views; they do not merge operations or participate in convergence.

- **Account/trust/runner registry:** a runner-local account genesis names the
  first owner key. Owner trust operations authorize admission, bounded
  delegation, renewal, revocation, and runner membership. Concurrent
  non-widening changes merge; revocation is remove-wins. Google can author only
  an identity binding/recovery assertion under its engine key purpose. Linking
  anonymous to Google retains the account/entity/operation IDs. An explicit
  existing-account merge preserves both provenances and rejects equivocation.
- **Tier/backup entitlement:** the engine's billing/identity control plane is
  the single writer for entitlement epochs. A later entitlement epoch supersedes
  an earlier one; it does not modify runner data. Backup frontiers are immutable
  acknowledgements per partition. Free endpoints reject rather than merge
  session operations. Downgrade quarantine/purge is storage lifecycle, not an
  application tombstone.
- **Workspaces:** UUIDv7 identity is immutable; name is LWW; delete is
  remove-wins. Concurrent same names remain distinct with disambiguators.
  Default workspace is an account register; deletion deterministically repairs
  to active workspace with lowest creation clock/ID.
- **Prompt bank:** name/body are separate LWW registers; delete is remove-wins.
  Different fields combine; losing concurrent bodies remain conflict revisions.
  Existing prompt `revision` is projection metadata, not a distributed clock.
- **Credential metadata:** labels, provider/source, version, policy, revoked
  state, and target receipts converge as metadata. Plaintext, sensitive generic
  URLs, and envelopes are absent. A recovered summary with no vault receipt is
  deterministically `credential unavailable`, never usable.
- **Session creation/configuration:** creation is immutable and names an
  executor. Title is LWW. Model, tools, directory, provider, and runner changes
  are executor-serialized requests at epoch boundaries. Two offline creates are
  distinct sessions. These operations have the session partition and a free
  engine cannot acknowledge them.
- **Session assignment/epoch:** one writer, monotonically increasing epoch, and
  signed handoff. No timeout election; stale output quarantines and unclean
  recovery forks.
- **Messages/turns/status/usage/tool results:** append-only and executor-owned
  for the certified epoch. IDs/ordinals are immutable. Duplicates dedupe; two
  values at one ordinal are equivocation. Their references and blobs inherit the
  session partition.
- **Pending input, answer, stop, and steer:** capable clients send immutable
  requests keyed by `clientRequestId` to a runner; cancel is remove-wins; the
  executor writes one terminal receipt. Causally ready requests sort by
  `(HLC, request ID)`. Reusing a key for another payload is rejected. A browser
  draft that never reaches a runner is not an operation and has no merge rule.
- **Attachments:** immutable SHA-256 blobs plus metadata, complete on every
  ready runner. Equal hashes dedupe. Reference classification controls engine
  tier: session-only bytes are paid-only, while any live non-session reference
  admits the byte object to free backup. Metadata tombstones govern safe
  collection.
- **Presence/live deltas, discovery descriptors, and browser caches/drafts:**
  ephemeral or client-local; they never affect frontiers, causal stability,
  compaction, or restore. A rendezvous registration is not a runner-registry
  operation, and candidate discovery cannot admit a replica.

### Why not a CRDT for the whole transcript?

A transcript reflects external model calls and filesystem-affecting tools.
Independent assistant branches cannot safely interleave because tool IDs,
replay, charges, and side effects depend on one causal turn. The design uses an
executor sequence. CRDTs apply around that boundary—not to conceal split brain.
