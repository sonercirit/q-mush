# Local-first architecture

Status: revised proposed design for
[epic #46](https://github.com/sonercirit/q-mush/issues/46). Merging the design
PR accepts the decisions in this document; implementation still lands as
separately reviewed stages.

This is the index and normative overview. Details are split to stay within the
repository's file-size policy:

- [Replication, tier partition, replica lifecycle, and execution authority](local-first/replication.md)
- [Entity convergence rules](local-first/convergence.md)
- [Runtime, transport, and app distribution](local-first/runtime-and-transport.md)
- [Trust, login, recovery, and security](local-first/trust-and-security.md)
- [Peer credential distribution](local-first/credentials.md)
- [Current architecture and migration constraints](local-first/current-state.md)
- [Implementation stages and testing](local-first/implementation.md)
- [Alternatives and open questions](local-first/decisions-and-questions.md)

## Decision

Q Mush will become a peer-first mesh of runner replicas with lightweight Solid
browser views and an entitlement-scoped engine backup.

1. **Every ready runner is a full account replica and an edge node.** Its
   standalone executable contains the browser assets, serves a local app/API,
   and stores every durable ordinary record and referenced application blob for
   each enrolled local account. That includes all sessions regardless of which
   runner executes them. A `joining` runner is not ready until its operation
   frontier, projection, tombstones, and blob manifest are complete.
2. **The Solid browser client is a partial, on-demand view—not a replica.** It
   fetches the records and blobs needed by the views in use from a reachable
   runner and may cache those views plus local drafts. It does not subscribe to
   the full log, advertise a replica frontier, retain a shared-operation outbox,
   or receive credential envelopes. A browser never satisfies redundancy,
   backup, readiness, retention, or compaction acknowledgement requirements.
3. **Login is optional.** A first runner can create an anonymous local account
   rooted in device keys, use the complete product locally, and directly pair
   the user's other runners without Google or the engine. Google login is only
   the gate to engine-backed identity and services. Linking later is lossless:
   the local account IDs, operations, sessions, blobs, trust root, and peer
   relationships remain valid while the entitled engine partition backfills.
4. **Logged-in accounts have free and paid engine tiers.** Both automatically
   maintain a readable engine backup of the non-session partition. Paid accounts
   additionally back up all session entities and their blobs and receive the
   managed rendezvous/relay service. The engine can query what it stores; this
   is deliberately not E2EE-blind backup. A free engine subscriber rejects
   session operations, snapshots, manifests, blobs, and acknowledgements.
5. **Ordinary data remains peer-first at all times.** Runners exchange
   operations and blobs directly whether or not the engine is healthy. Each
   runner-to-engine backup relationship is an independent subscription. The
   engine never bridges runner A to runner B, never becomes the routine
   data-plane route, and never brokers commands or live output. Its paid opaque
   relay is an explicit last resort whose encryption terminates only at the
   endpoint peers.
6. **Replication uses a typed, append-only operation log.** Operations have
   UUIDv7 IDs, per-device sequence numbers, causal frontiers, hybrid logical
   clocks, scopes, schema versions, and signatures. SQLite projections are
   rebuilt from verified operations and snapshots. Domain-specific merge rules
   apply; a SQL row is not a generic last-write-wins register.
7. **A session has exactly one execution authority.** Its assigned runner owns
   an execution epoch and alone appends canonical transcript, status, usage, and
   tool-result operations for that epoch. Inputs are requests until that runner
   accepts them. Transfer requires a signed handoff; unclean loss creates a
   visible recovery fork instead of risking duplicate model or filesystem
   effects.
8. **Secrets use a separate runner credential plane.** Non-secret credential
   summaries, policies, and delivery receipts replicate, but plaintext and
   envelopes do not enter browser caches, ordinary operations, blobs, or engine
   backup. User-entered API keys, generic endpoints, and Brave keys distribute
   directly between runner vaults with no engine request.
9. **Provider authorization is runner-side.** OpenAI uses a device-code flow:
   the runner shows the provider verification URL/code, polls the token
   endpoint, and stores the result in its vault, with no callback listener or
   engine involvement. OpenRouter's current PKCE flow accepts a caller-supplied
   callback and has no registered client credential, so its callback terminates
   at the initiating runner rather than the engine. Google identity is the
   engine's only target OAuth/OIDC flow.
10. **Steady-state trust is peer-side.** Anonymous account genesis and owner
    keys originate on a runner. An authorized owner device admits, renews, and
    revokes runners or browser clients with signed capability grants. Google can
    bind that trust root to an engine account and recover it after total runner
    loss, but the engine cannot sign ordinary data or execution epochs.

A “full account replica” means the complete shared Q Mush data set for one local
account, not every account known to an engine and not a copy of arbitrary source
trees. Workspace records, session attachments, and deliberately imported files
replicate; working directories remain external runner resources. Live presence,
unfinished stream deltas, and browser-local drafts are ephemeral. Provider
secrets are durable but use the separate vault boundary described in
[credentials.md](local-first/credentials.md); “all” in the backup matrices means
all ordinary replicated application data within that boundary.

## Availability and recovery guarantee

Every ready runner contains all ordinary data through its declared frontier, so
failure of one ready runner does not erase that frontier or stop surviving
runners. A new local write is durable on its author but is visibly `local-only`
until another eligible durable replica acknowledges the operation and any blob.
No local-first design can recover a host destroyed before an offline write
leaves it. The engine separately exposes its last durable backup frontier, and
total-runner-loss recovery is guaranteed through that acknowledged frontier:

| Mode            | Readable engine backup                          | Recovery after every runner is lost                                          |
| --------------- | ----------------------------------------------- | ---------------------------------------------------------------------------- |
| Anonymous       | None                                            | None; total loss is explicitly accepted                                      |
| Logged in, free | Non-session partition, default-on               | Account/configuration data returns; session history and session blobs do not |
| Logged in, paid | Non-session plus session partitions, default-on | All ordinary records and application blobs return                            |

Browser caches never improve these guarantees. Credential summaries recover in
free and paid modes; vault secrets require another runner or the separately
chosen credential-recovery mechanism. The exact entity partition, including the
otherwise ambiguous `sessions` login table, is normative in
[replication.md](local-first/replication.md#engine-backup-partition-by-schema-entity).

A free-to-paid upgrade starts a complete session/tombstone/blob backfill and is
not labeled fully backed up until the engine verifies and acknowledges it. A
paid-to-free downgrade immediately stops session ingestion and, under the
proposed policy, quarantines the existing paid session backup for a 30-day
re-upgrade grace period before purging it. The duration and involuntary billing
failure treatment remain an explicit product question; runners never delete
their full copies because of tier.

## Current architecture and constraints

Today the engine serves the app, requires Google login, owns relational state
and provider credentials, runs model orchestration, and brokers tool commands to
an outbound-only runner. The target removes those runtime couplings. Existing
foundations, the observed OpenAI/OpenRouter callback behavior, schema migration
hazards, and workspace import boundaries are catalogued in
[current-state.md](local-first/current-state.md). Caching JavaScript alone would
not address the dependency.

## Target topology

```text
                              Google identity
                                    |
                                    v
                  +-----------------------------------+
                  | sync engine                       |
                  | readable backup subscriber        |
                  | free: non-session; paid: all data |
                  | paid rendezvous / opaque relay    |
                  +---------:---------------:---------+
                            :               :
                  independent backup subscriptions
                            :               :
+---------------------------:---------------:---------------------------+
|                           :               :                           |
|  +------------------------v-+  direct   +-v------------------------+  |
|  | runner A                 |<=========>| runner B                 |  |
|  | full SQLite + all blobs  |  peer     | full SQLite + all blobs |  |
|  | app/API/executor/vault   |  mesh     | app/API/executor/vault  |  |
|  +------------^-------------+           +-------------^-----------+  |
|               | on-demand views, commands, live output |              |
|               +-------------------+--------------------+              |
|                                   |                                   |
|                     +-------------v-------------+                     |
|                     | Solid browser client      |                     |
|                     | partial view/cache/drafts |                     |
|                     | never a replica member    |                     |
|                     +---------------------------+                     |
+-----------------------------------------------------------------------+

        runners ---- runner-side device/PKCE/API flows ---- providers
```

The three component roles remain separate even when a runner serves the Solid
assets. Serving code does not make the browser process part of that runner's
SQLite replica. The engine may serve its own stored frontier during explicit
restore, but it cannot forward one live runner stream as another runner's
ordinary route.

| Component            | Durable state                                                                  | Execution      | Role                                                                      |
| -------------------- | ------------------------------------------------------------------------------ | -------------- | ------------------------------------------------------------------------- |
| Runner               | Full ordinary account state and all blobs; target-bound secrets in its vault   | Epochs it owns | App/API host, peer replication, tools, trust admission                    |
| Solid browser client | Only current-view cache, selected blobs, local preferences/drafts; no frontier | No             | Authenticated window and request client to runners                        |
| Sync engine          | Identity/control state plus readable entitled backup; no provider vault        | No             | Google identity/recovery, backup/restore, paid rendezvous/relay, releases |

## Authority and data boundaries

- **Ordinary replicated state:** account/workspace metadata, trust and runner
  registries, credential summaries, prompts, session records, canonical
  messages, attachments, tombstones, pending requests, receipts, and usage go to
  every runner. The engine subscribes only to its tier partition.
- **Executor-owned state:** session runner, epoch, turn sequence, transcript
  output, status, usage, and tool effects have one writer. Other replicas verify
  and retain the resulting operations.
- **Secret state:** provider credential payloads and target envelopes exist only
  in private runner vaults/channels. Backed-up summaries cannot recreate them.
- **Control state:** Google subject, tier entitlement, engine web-login token,
  and billing state are engine control records. They do not grant operation or
  execution authority and bearer login tokens are not replicated.
- **External/ephemeral state:** source trees, presence, transient deltas, and
  browser drafts are not shared durable records. Final output and deliberately
  imported files cross the ordinary replication boundary.

## Required invariants

1. Every ready runner stores the complete account operation frontier,
   projection, and referenced blob manifest; session assignment, workspace, age,
   tier, and demand cannot filter it.
2. The Solid browser requests partial views on demand and never advertises a
   replica acknowledgement or counts toward safety, backup, compaction,
   tombstone collection, or readiness. The engine subscriber may acknowledge
   only the tier partition it durably stores.
3. Applying an operation, snapshot, blob chunk, or secret delivery twice has no
   effect after the first successful application.
4. Honest replicas with the same authorized operation set materialize the same
   result independent of delivery order; wall-clock `updatedAt` is not a merge
   rule.
5. Ordinary operations, blobs, commands, receipts, and live output use direct
   endpoint peer sessions. Engine backup links are independent destinations,
   never inter-runner bridges.
6. A free engine endpoint rejects every session entity and session-owned blob
   before storage and emits no durable acknowledgement for it. Paid access is
   based on engine-authoritative entitlement, not a runner claim.
7. Every model/tool output names an execution epoch and is signed by its
   authority. Stale or non-authority output is quarantined.
8. Inputs and new writes display their actual local, runner-redundant, and
   engine-backup status; `local-only` is never called backed up.
9. Deletes remain tombstones and materialize through `isDeleted`. UUIDv7 entity
   IDs remain stable across anonymous login linking and tier transitions.
10. Owner peers can admit, renew, and revoke devices without the engine;
    delegation cannot widen the issuer's scope.
11. User-entered secrets and provider authorization tokens never traverse the
    engine. OpenAI device authorization and OpenRouter PKCE complete at runners.
12. Plaintext and sealed credential payloads never enter browser persistence,
    ordinary operations/snapshots/blobs, engine backup, discovery, diagnostics,
    exports, or logs.
13. Version skew fails affected writes closed while retaining compatible local
    reads. Updating or logging in to the engine is never required to open a
    runner's embedded app.

## Product behavior when the engine is absent

With any reachable ready runner, an anonymous or previously linked user can open
the embedded app and read every session, message, prompt, workspace, runner
record, and attachment—not only data created there. The user can edit convergent
state, execute on a credential-authorized runner, steer/stop/answer, compact,
browse that runner's directories, and spawn or hand off directly. Hosted models
still require their provider network.

Owner devices can pair/revoke peers and distribute user-entered credentials.
OpenAI device-code authorization and OpenRouter's runner callback also work
without the engine. A browser with no runner can read only cached views and edit
local drafts; it cannot commit shared operations, count as a data copy, execute,
or access a filesystem.

Engine loss disables new Google linking/recovery, progress to the engine backup
frontier, paid engine-only rendezvous/relay routes, and releases available from
no peer or mirror. It does not disable runner replication, local execution,
routine device administration, provider authorization, or credential
provisioning. After total runner loss, Google plus the engine backup is required
to recover a free or paid account.

## Success criteria

The epic is complete only when automated outage, entitlement, restore, and
capture tests demonstrate:

- Every ready runner lists all sessions, opens every durable attachment, and
  rejects assignment-scoped or metadata-only readiness.
- A long-offline runner rebuilds from a compatible runner snapshot plus tail and
  remains `joining` until its full manifest verifies.
- Browsers fetch bounded view projections and never emit replica/frontier or
  compaction acknowledgements; destroying all runners cannot treat IndexedDB as
  recovery input.
- Healthy-engine path assertions show direct runner traffic and independent
  backup subscriptions, with no engine broker/fan-out. Forced route failure is
  visibly relayed end-to-end or reports `No route`.
- Anonymous runners initialize, execute, and pair without engine traffic, then
  link to Google without changing IDs or losing an operation/blob. Tier backfill
  status is accurate throughout.
- A free engine rejects all five schema session entities and their blobs while
  retaining every non-session entity; paid upgrade backfills all session data.
  Downgrade stops ingestion, enforces grace/purge policy, and never alters
  runner copies.
- Total runner loss restores the acknowledged non-session frontier for free and
  complete ordinary frontier/blob manifest for paid; anonymous recovery clearly
  reports that no backup exists.
- Blocking the engine still permits API/generic/Brave provisioning, OpenAI
  device authorization, OpenRouter runner-local PKCE, and runner-to-runner
  envelope delivery. No provider secret appears in browser or ordinary backup
  captures.
- Killing an executor loses no previously replicated history. Stale authority,
  malformed operations, version skew, DNS rebinding, partitions, and resource
  exhaustion fail as specified.

The staged path is defined in
[implementation.md](local-first/implementation.md).
