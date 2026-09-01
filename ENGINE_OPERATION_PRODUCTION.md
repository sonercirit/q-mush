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
before authentication and JSON parsing. The checkpoint cap is 32 MiB: a folded
100-prompt bank with worst-case NUL escaping measures about 19.5 MiB including
names/write metadata, leaving about 12 MiB for replay. Checkpoints encode one
projection and reconstruct the current projection from retained replay, avoiding
duplicate projection storage without changing decoded state. Oversized
replay-driven bursts fail closed and can self-heal after the five-minute
stability fold; envelope deletion still awaits durable receipts. A
projection-driven failure requires deleting an entity to release its retained
payload, so prompt deletion clears retired name/body writes while preserving its
remove-wins tombstone. The 32 MiB cap makes that failure unreachable for every
legacy-admissible 100-prompt bank.

The producer mints beyond stored account-writer sequences, dominates checkpoint
clocks, and chains command parents/clocks. A backward wall-clock command can
still stall behind the recorded admission-clock issue. The engine is now the
authoritative account-writer author; browser POSTs with that writer can race and
equivocate, so per-device writer identity remains open. Workspace-create latency
measured 87.33–96.05 ms after an unfolded 500-operation/500-workspace burst and
39.88–47.75 ms after stability folding across three development-runner runs.
Folding removes replay history but not projection/checkpoint size: command cost
remains O(projection + checkpoint bytes) and therefore grows with total account
entity count.

A full-scale real-store probe created 100 distinct maximum 32 KiB prompts with
commands ten minutes apart. The ASCII bank completed with zero capacity
failures; the command at full state took 35.96 ms and the final checkpoint was
3,506,230 bytes. Repeating with worst-case NUL bodies also completed all 100
with zero capacity failures; the command at full state took 217.28 ms and the
final encoded checkpoint was 20,447,286 bytes, below 32 MiB with 13,107,146
bytes of headroom.

The earlier 1.06/0.70 ms claim was invalid. Its probe repeatedly renamed one
workspace, so LWW projection size stayed tiny. Although the exact scenario
retained about 503 envelopes, it still measured a one-workspace projection—not
an unfolded 500-operation/500-entity account.
