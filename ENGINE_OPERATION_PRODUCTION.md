# Engine command operation production

Workspace and prompt REST commands now write canonical operations through shared
intake in the same SQLite transaction as legacy rows. Lazy first-touch backfill
creates referenced legacy entities and the account default register; every
successful command leaves both faithful in projection, while deletes remain
create-free. Auth's inline genesis workspace deliberately remains
operation-free. Until backfill, creation-clock default repair can differ from
legacy `createdAt`; the explicit register then wins. No schema/data migration is
required.

Prompt body's 32 KiB input plus worst-case JSON escaping requires the 256 KiB
envelope cap. POST batches, pull pages, and runner pushes are capped at 4 MiB;
synchronization POST bodies are additionally bounded at 5 MiB while streaming,
before authentication and JSON parsing. This deliberately buffers up to about 5
MiB before authentication, replacing the previous unbounded post-auth buffering.
The checkpoint cap is 32 MiB: a folded 100-prompt bank with worst-case NUL
escaping measures about 19.5 MiB including names/write metadata, leaving about
12 MiB for replay. Checkpoints encode one projection and reconstruct the current
projection from retained replay, avoiding duplicate projection storage without
changing decoded state. Oversized replay-driven bursts fail closed and can
self-heal after the five-minute stability fold; envelope deletion still awaits
durable receipts. A projection-driven failure requires deleting an entity to
release its retained payload, so prompt deletion clears retired name/body writes
while preserving its remove-wins tombstone. The 32 MiB cap makes that failure
unreachable for every legacy-admissible 100-prompt bank. The cap bounds stored
checkpoint bytes in the alias form, not decoded memory: decoding materializes
both base and current projections, so the worst-case bank used about 40
MB—roughly twice its honest full form—and decoded RAM has no separate cap.

The producer mints beyond stored account-writer sequences, dominates checkpoint
clocks, and chains command parents/clocks. A backward wall-clock command can
still stall behind the recorded admission-clock issue. The engine is the sole
author of account-writer envelopes. Browsers cannot read or author envelopes;
they submit commands through REST. The synchronization route accepts only a
native runner bearer and `self` owner alias. Its authenticated runner row UUIDv7
is the device writer ID, so a runner may push only envelopes for its account and
its own writer sequence; no runner producer exists yet. The bearer token remains
the device authenticator until purpose-separated device keys land.
Workspace-create latency measured 87.33–96.05 ms after an unfolded
500-operation/500-workspace burst and 39.88–47.75 ms after stability folding
across three development-runner runs. Folding removes replay history but not
projection/checkpoint size: command cost remains O(projection + checkpoint
bytes) and therefore grows with total account entity count. Runner-authored
workspace operations and the `users` default-workspace register are admissible
and reflected during intake; every other runner-authored entity kind fails
closed before persistence. Fold liveness no longer depends on retained
per-writer heads: shared compaction retains strict pending-clock caps and
rejects backward/no-op boundaries. Engine intake's symmetric drift bound makes
every post-boundary admission newer; its producer mints above stable, replay,
and pending clocks. Per-writer heads remain independent, so a dormant fully
folded device writer cannot pin an active account writer's replay.

Backfill is conditional: it emits only for touched legacy-only workspaces absent
from projection, and emits the default register only when required and absent.
Ensure-create is fill-if-absent: reducers retain early field registers before
creation, then ensure fills `created` and missing registers without overwriting
existing values. This includes delete-before-ensure: ensure records creation and
the legacy name while preserving the remove-wins tombstone, so reflection can
soft-delete rather than lose the entity identity. Checkpoint round trips
preserve both intermediate arrival orders. This must be order-independent
because producer and per-writer floors make minting below prior clocks
impossible in general. Reflection mirrors the projection's effective default.
Before assigning that default, reflection clears `is_default` on every owner
row, then sets the selected row while applying projection rows; this statement
order is required by the partial unique index. With active workspaces exactly
one active legacy row is default; with zero, `list` returns the global ID as a
deterministic non-throwing placeholder until lazy repair or creation. A
near-unreachable cross-owner UUID collision fails reflection rather than
mutating another owner.

Runner workspace names must already equal shared normalized form: non-empty
after trim, at most 100 characters, and not case-insensitively `global`.
Immutable invalid values fail the whole batch with 400; values are never
trimmed. Duplicate names remain allowed for legitimate CRDT convergence. Engine
and UI paths identify, select, and key workspaces by ID, never by name.
Envelope, checkpoint, conditional backfill, and reflection share one
transaction. The runner-local producer remains deferred and local
`ownsOperation` stays closed. Rejected or stalled runner pushes retain their
outbox data and use capped backoff, preventing both loss and a tight livelock.
Replica pull currently trusts the authenticated engine response; scope and
writer assertions on that pull path arrive with the trust plane.

A full-scale real-store probe created 100 distinct maximum 32 KiB prompts with
commands ten minutes apart. The ASCII bank completed with zero capacity
failures; the command at full state took 35.96 ms and the final checkpoint was
3,506,230 bytes. Repeating with worst-case NUL bodies also completed all 100
with zero capacity failures; the command at full state took 217.28 ms and the
final encoded checkpoint was 20,447,286 bytes, below 32 MiB with 13,107,146
bytes of headroom.

The earlier 1.06/0.70 ms claim was invalid. Its probe repeatedly renamed one
workspace, so LWW projection size stayed tiny. Although the exact scenario
retained about 503 envelopes, it still measured a two-workspace projection—the
backfilled legacy default plus the created workspace—not an unfolded
500-operation/500-entity account.
