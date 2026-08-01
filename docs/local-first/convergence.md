# Convergence rules

This document is normative detail for the
[local-first architecture](../local-first-architecture.md). Operation and
full-replica storage mechanics are specified in
[replication.md](replication.md).

“LWW” means an HLC register with causal context and device-ID tie-break, never
`updatedAt`. IDs—not unique display names—define identity.

- **Account/trust/runner registry:** the account's owner-device trust chain
  authorizes admission, capability-bounded delegation, renewal, revocation, and
  runner membership. Concurrent non-widening updates merge; revocation is
  remove-wins. The engine can author only identity recovery/bootstrap records
  within its explicit key purpose. Credential secrets use the separate plane.
- **Workspaces:** creation has immutable UUIDv7 identity; name is LWW; delete is
  remove-wins. Concurrent same names remain distinct with stable disambiguators.
  Default workspace is an account LWW register; a deleted target
  deterministically repairs to the active workspace with lowest creation
  clock/ID.
- **Prompt bank:** name and body are separate LWW registers; delete is
  remove-wins. Different-field edits combine. Concurrent body losers remain
  conflict revisions for compare/restore. Existing prompt `revision` is a local
  projection revision, not a distributed clock.
- **Session creation/configuration:** creation is immutable and names an
  executor. Title is LWW. Model, tools, directory, provider, and runner changes
  are requests serialized or rejected by the executor at an epoch boundary. Two
  offline creates are two sessions.
- **Session assignment/epoch:** one writer with monotonically increasing epoch
  and signed handoff. There is no timeout election. Stale output is quarantined;
  unclean recovery forks.
- **Messages/turns/status/usage/tool results:** append-only and executor-owned
  for the certified epoch. IDs and per-epoch ordinals are immutable. Duplicate
  operations dedupe; two values at one ordinal are equivocation and quarantine.
- **Pending input, answer, stop, and steer requests:** any capable device
  creates an immutable request keyed by `clientRequestId`; cancel is
  remove-wins; the executor writes one terminal receipt. It accepts causally
  ready requests in deterministic `(HLC, request ID)` order and assigns queue
  sequence. A reused idempotency key with another payload hash is rejected.
- **Attachments:** immutable SHA-256 blobs plus metadata, eagerly completed on
  all ready runners. Equal hashes dedupe. Metadata tombstones control visibility
  and safe byte collection.
- **Credential records:** provider/type labels, version, policy, revoked state,
  and target delivery receipts are convergent metadata. Plaintext and sealed
  payload bytes are not operations and are never reconstructed from this state.
- **Presence/live deltas and browser drafts/preferences:** ephemeral/profile-
  local as described above.

### Why not a CRDT for the whole transcript?

A transcript reflects an external model call and filesystem-affecting tools.
Independent assistant branches cannot be safely interleaved: tool IDs, replay,
provider charges, and side effects depend on one causal turn. The target uses an
executor sequence. CRDTs apply around that boundary—inputs and user metadata—not
to conceal split brain.
