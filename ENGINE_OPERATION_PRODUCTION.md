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
envelope cap. POST batches, pull pages, and runner pushes are capped at 4 MiB,
with at least one envelope per page/batch. Oversized bursts fail closed and can
self-heal after the five-minute stability fold; envelope deletion still awaits
durable receipts.

The producer mints beyond stored account-writer sequences, dominates checkpoint
clocks, and chains command parents/clocks. A backward wall-clock command can
still stall behind the recorded admission-clock issue. The engine is now the
authoritative account-writer author; browser POSTs with that writer can race and
equivocate, so per-device writer identity remains open. Workspace-create latency
measured 1.06 ms after an unfolded 500-operation burst and 0.70 ms after that
history folded stable on the development runner; each command pays full
checkpoint decode/apply/encode.
