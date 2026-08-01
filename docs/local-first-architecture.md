# Local-first architecture

Status: revised proposed design for
[epic #46](https://github.com/sonercirit/q-mush/issues/46). Merging the design
PR accepts the decisions in this document; implementation still lands as
separately reviewed stages.

This is the index and normative overview. Details are split to stay within the
repository's file-size policy:

- [Replication, replica lifecycle, and execution authority](local-first/replication.md)
- [Entity convergence rules](local-first/convergence.md)
- [Runtime, transport, and app distribution](local-first/runtime-and-transport.md)
- [Trust, degraded operation, and security](local-first/trust-and-security.md)
- [Peer credential distribution](local-first/credentials.md)
- [Current architecture and migration constraints](local-first/current-state.md)
- [Implementation stages and testing](local-first/implementation.md)
- [Alternatives and open questions](local-first/decisions-and-questions.md)

## Decision

Q Mush will become a peer-first mesh of durable replicas rather than a browser
and tool worker attached to one authoritative process.

1. **Every runner is a full account replica and an edge node.** Its standalone
   executable contains the browser assets, serves a local app and API, and keeps
   every durable, non-secret application record for its enrolled user/account in
   SQLite: account/user metadata needed by the app, workspaces, prompt bank,
   runner registry, trust metadata, sessions regardless of executor, messages,
   turns, pending inputs, questions, usage, tombstones, and every referenced
   attachment/blob. Assignment, recent use, workspace, and storage pressure
   never select a subset. A runner may be `joining` while it catches up; it is
   not advertised as a ready runner until the complete operation frontier and
   blob manifest are present.
2. **Ordinary data is peer-first at all times.** Runners and browser profiles
   exchange operations over authenticated peer connections whether or not the
   sync engine is healthy. The logical data plane is endpoint-to-endpoint and
   never engine-brokered. Peers use a direct transport wherever one can be
   established. When direct connectivity is impossible, an end-to-end encrypted
   byte relay may carry that same peer connection only as an explicit, visible
   last-resort fallback; it cannot terminate, inspect, authorize, merge, or
   store-and-forward ordinary data. The engine may rendezvous peers, validate an
   external identity, independently subscribe as an optional backup peer, or
   operate that opaque fallback, but engine availability never makes relay the
   default path.
3. **Every browser profile is a local replica; every open tab is a peer.** A
   browser profile stores an authorized projection and operation outbox in
   IndexedDB. Unlike a runner, its history/blob cache may be partial and
   quota-managed. Same-origin tabs coordinate through `BroadcastChannel`; tabs
   connect outward to runners over WebSocket or WebRTC and never need an inbound
   listener. Browser replicas never hold provider or skill secrets.
4. **The sync engine has a narrow, nonessential role.** It supports Google
   identity bootstrap/recovery and genuine third-party OAuth handshakes that
   need a registered callback or confidential exchange; it may also provide
   optional rendezvous, release publication, backup subscription, or opaque
   fallback transport. It is not the routine issuer for peer grants, not a
   credential provisioning service, not a merge leader, and not in a
   runner-owned execution path. Existing engine data and execution paths are
   migration sources, not the target architecture.
5. **Replication uses a typed, append-only operation log.** Operations have
   UUIDv7 IDs, per-device sequence numbers, causal frontiers, hybrid logical
   clocks, account/workspace scope, schema versions, and signatures. SQLite and
   IndexedDB are materialized projections. Domain-specific CRDT rules handle
   multi-writer state; generic last-write-wins is not applied to an entire SQL
   row.
6. **A session has exactly one execution authority.** Its assigned runner owns
   an execution epoch and alone may append canonical transcript, status, usage,
   and tool-result operations for that epoch. Inputs may be authored anywhere,
   but they are requests until that runner accepts them. There is no automatic
   takeover of an unreachable runner: transfer needs a signed handoff, and an
   unclean loss is recovered by forking rather than risking duplicate model
   turns or filesystem side effects. Every other runner still has the complete
   verified session and can read it or use it as the recovery-fork frontier.
7. **Secrets use a distinct peer credential plane.** Credential metadata and
   target availability may replicate, but plaintext and sealed payloads never
   enter browser storage, the operation log, snapshots, blobs, or ordinary sync.
   A runner receiving a user-entered API key, generic endpoint credential, or
   Brave key encrypts a separate envelope to each authorized runner's device key
   and sends it directly over authenticated runner peer links. No engine
   round-trip occurs. For OpenAI/OpenRouter OAuth, the engine performs only the
   unavoidable handshake, seals the result to the initiating runner, retains no
   token record, and that runner distributes fresh per-device envelopes
   peer-to-peer.
8. **Steady-state trust is delegated peer-side.** Google can bind the first
   owner device or recover a lost trust root. Thereafter an already trusted
   owner device directly admits, renews, and revokes runner/browser devices with
   signed, capability-bounded grants. A runner grant includes the full account
   replica; workspace scopes constrain execution and secret use, not which
   durable account records that runner stores. Revocations gossip over the peer
   plane, with the engine only an optional observer/rendezvous peer.

“Full account replica” means the complete shared Q Mush data set for the
account, not every other account hosted by the same engine. It also does not
silently turn an external working directory into a replicated filesystem.
Workspace records, session attachments, and any file deliberately imported into
Q Mush are fully replicated; source trees and runner-local paths remain external
tool resources. Ephemeral presence/live deltas and explicitly profile-local
drafts/preferences are not durable shared state. Secrets are the only durable
user data using a separate distribution/store boundary, and the default
credential policy targets all trusted executor runners with independent device
envelopes. A user may narrow that policy, but the UI must label the resulting
loss of credential failover.

The availability guarantee is precise. Every ready runner holds all durable
shared state through its declared ready frontier, so failure of any one
previously ready runner neither removes that state nor prevents surviving ready
runners from serving it. Each new operation still has an unavoidable replication
interval: a write created while no second runner is reachable is usable and
durable locally but visibly `local-only` until another runner acknowledges it.
No system can promise survival of the authoring host during that interval. Loss
of a session's active executor can interrupt that external action or its local
working tree, but not erase its previously replicated session or prevent other
runners from serving/changing unrelated state. Disconnected peer islands
converge directly when a route returns.

## Current architecture and constraints

The current implementation is server-centric: the engine serves the app,
terminates browser/runner realtime sockets, owns relational state and provider
credentials, runs model orchestration, and brokers tool commands to an
outbound-only runner. The target deliberately removes each runtime coupling.
Existing reusable foundations, migration hazards, and enforced workspace
boundaries are catalogued in [current-state.md](local-first/current-state.md).
Caching only JavaScript would not address the present engine dependency.

## Target topology

```text
                         Google / OAuth provider
                                  |
                    +-------------v--------------+
                    | sync engine (optional peer)|
                    | identity/OAuth handshake,  |
                    | rendezvous, release source,|
                    | optional backup subscriber|
                    +-------------+--------------+
                                  : independent peer subscription
                                  : (never an A-to-B data bridge)
                                  :
        +-------------------------+-------------------------+
        |                                                   |
+-------v--------+       direct authenticated       +-------v--------+
| runner A       |<===============================>| runner B       |
| full SQLite +  |                                  | full SQLite +  |
| every blob     |<=============>+                  | every blob     |
| app/API/exec   |               ||                 | app/API/exec   |
+---^--------^---+               ||                 +---^--------^---+
    |        |                   || direct mesh         |        |
 WebSocket WebRTC          +-----vv-------+          WebRTC WebSocket
    |        +------------>| runner C     |<------------+        |
+---+---------+             | full replica|             +--------+---+
| tab/profile |             +-------------+             | tab/profile |
| IndexedDB   |<----------- direct WebRTC ------------>| IndexedDB   |
+-------------+                                         +-------------+
```

Each edge sends its own frontier to the other endpoint. If both runners also
subscribe the engine as a backup, those are two independent replication
relationships; the engine never forwards A's stream as B's ordinary route. A
last-resort relay, when explicitly selected, is an opaque live byte tunnel with
end-to-end peer authentication and is shown as degraded connectivity.

| Peer                | Durable state                                                                                   | May execute a session        | Special role                                                                                  |
| ------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------- |
| Runner edge         | Full account operation/projection state and all blobs; only target-bound envelopes in its vault | Yes, only for epochs it owns | Local directory/tool access, peer admission when owner-authorized, graceful authority handoff |
| Browser profile/tab | Authorized IndexedDB projection/outbox and selected blob cache; no secret envelope              | No                           | Submit requests and convergent user edits within its grant                                    |
| Sync engine         | Identity/OAuth records and optional independent backup replica; no required credential vault    | Migration-only legacy path   | Google/OAuth handshake, optional recovery/rendezvous, release publication                     |

## Authority and data boundaries

The design separates four kinds of state rather than pretending all SQL rows are
one CRDT:

- **Full replicated application state:** account/workspace metadata, runner and
  trust registries, sessions, canonical messages, content-addressed attachments,
  prompt fields, tombstones, pending requests, receipts, and usage replicate to
  every runner. Browser and optional engine replicas may retain a subset
  according to their role.
- **Executor-owned state:** session runner, execution epoch, turn sequence,
  transcript output, status, usage, and tool effects have one writer. Other
  peers verify and retain all resulting durable operations but cannot author
  them.
- **Secret state:** credential policy/version/availability is replicated
  metadata. Plaintext, generic endpoint details, API keys, OAuth refresh tokens,
  and target envelopes move only through the credential plane and live only in
  runner private vaults. The engine sees OAuth results transiently only when the
  provider handshake inherently terminates there.
- **External or ephemeral state:** runner working trees, live presence and
  streaming deltas are not durable Q Mush records. Browser drafts/preferences
  stay profile-local unless promoted to a shared entity. Final stream results
  and imported files cross into full replication before being presented as
  redundantly durable.

The operation format, catch-up rules, conflict policies, handoff protocol, and
reconciliation behavior are specified in
[replication.md](local-first/replication.md).

## Required invariants

Implementation stages and migration adapters must preserve these properties:

1. Every ready runner stores the complete account operation frontier,
   projection, and referenced blob manifest. Session assignment, workspace, age,
   and local demand cannot filter runner replication.
2. Applying an operation, snapshot, blob chunk, or secret delivery twice has no
   effect after the first successful application.
3. Two honest replicas with the same authorized operation set materialize the
   same user-visible state independent of delivery order. Wall-clock time alone
   never chooses a winner.
4. Ordinary data and commands use endpoint-to-endpoint peer sessions even while
   the engine is available. An engine service never terminates or brokers them;
   a last-resort relay only tunnels opaque, end-to-end authenticated peer frames
   and remains explicitly diagnosed.
5. Every canonical model/tool message names one session execution epoch and is
   signed by that epoch's authority. Stale or non-authority output is
   quarantined.
6. An input shown as `local-only` or `queued` is not shown as accepted,
   redundantly stored, or executed until the corresponding durable receipts
   exist.
7. Deletes remain tombstones and materialize through `isDeleted`. UUIDv7 entity
   IDs remain stable; device sequence and clock metadata augment rather than
   replace them.
8. Admission, renewal, and revocation can be signed and exchanged by already
   trusted owner peers without an engine request. Delegation cannot widen the
   issuer's scope or capabilities.
9. User-entered API keys, generic endpoints/keys, and Brave keys never contact
   the engine. They are independently sealed to authorized runner device keys
   and sent over the runner credential plane.
10. OAuth tokens leave the engine only as a handshake-bound sealed result to an
    initiating runner; subsequent distribution/rotation is peer-to-peer. The
    engine does not retain a token row or act as envelope fan-out.
11. Plaintext and sealed credential payloads never enter IndexedDB, browser
    caches, ordinary operations/snapshots/blobs, peer discovery, diagnostics,
    bundles, or logs. Non-secret policy and signed availability receipts may.
12. Version skew fails writes closed while retaining a compatible read-only
    view. Updating the engine is never required to open a runner's embedded app
    or to sync compatible peers.

## Product behavior when the engine is absent

With any reachable ready runner, a paired user can open the embedded app and
read every session, message, prompt, workspace record, runner record, and
attachment in the account replica—not only sessions executed there. The user can
edit convergent state, create or continue a session on a credential-authorized
runner, steer/stop/answer, compact, browse that runner's directories, and spawn
or hand off to another directly reachable runner. Hosted models still require
their provider network.

An existing owner device can pair a browser or runner, renew bounded grants,
revoke a peer, and distribute the resulting trust operations directly. A user
can add, rotate, revoke, and distribute API-key, generic-provider, and Brave
credentials through a runner without the engine. Existing OAuth material can be
resealed among authorized runners. Targets that are offline receive it when a
credential-holding runner next reaches them.

With no runner reachable, an installed/cached browser can read its IndexedDB
projection, edit supported convergent fields, preserve drafts, and queue input
requests. It cannot claim to run a model or access a live filesystem. Browser
cache completeness is shown separately from runner replica completeness.

Engine loss disables only functions that inherently terminate there: a new
Google login/trust-root recovery, a new or renewed third-party OAuth handshake
whose registered flow uses the engine, candidates known only to engine
rendezvous, the engine-operated last-resort relay, a not-yet-replicated release,
and the optional engine backup. It does not disable ordinary data sync, routine
device administration by an owner peer, user-entered credential provisioning, or
runner execution.

## Success criteria

The epic is complete only when automated outage and capture tests demonstrate:

- Every ready runner can list and read all sessions—including those assigned to
  every other runner—and locally open every durable attachment. Completeness
  checks reject a metadata-only or assignment-scoped replica.
- A runner that was offline beyond log compaction rebuilds from a peer snapshot,
  resumes all blobs, applies the operation tail, and is not marked ready until
  its full manifest verifies.
- With the engine healthy, packet/path assertions show runner/browser ordinary
  replication and commands using peer connections, with no engine
  broker/fan-out. Forced direct-route failure uses a visibly last-resort opaque
  relay or reports no route.
- Blocking all engine endpoints still permits adding/rotating a generic LLM
  endpoint/key, API key, and Brave key on one runner and delivering independent
  sealed envelopes to every authorized reachable runner. No secret appears in
  browser storage or ordinary sync captures.
- An OAuth test lets the engine complete only the provider handshake, verifies
  immediate sealed handoff/no durable engine token, then verifies runner-to-
  runner distribution without another engine request.
- Killing the engine before or during a runner-owned model turn does not affect
  the turn, local tools, direct control, or replication. A fresh tab from any
  runner reads the full account replica without an engine cookie.
- Killing one ready runner loses no operation/blob through its advertised ready
  frontier: every surviving ready runner already has that state. A test that
  kills an author before its newer `local-only` write replicates must show the
  explicitly warned interval rather than claim impossible redundancy. Loss of an
  active authority interrupts only that execution; another runner serves its
  verified history and can create a visible recovery fork.
- Partitioned peers converge deterministically after a direct route returns;
  executor split-brain, stale grants, malformed operations, version skew,
  DNS-rebinding, and resource exhaustion fail as specified.

The staged path is defined in
[implementation.md](local-first/implementation.md).
