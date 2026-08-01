# Local-first architecture

Status: proposed design for
[epic #46](https://github.com/sonercirit/q-mush/issues/46). Merging the design
PR accepts the decisions in this document; implementation still lands as
separately reviewed stages.

This is the index and normative overview. Details are split to stay within the
repository's file-size policy:

- [Replication and execution authority](local-first/replication.md)
- [Runtime, transport, and app distribution](local-first/runtime-and-transport.md)
- [Trust, degraded operation, and security](local-first/trust-and-security.md)
- [Implementation stages, alternatives, and open questions](local-first/implementation.md)

## Decision

Q Mush will become a mesh of durable replicas rather than a browser and tool
worker attached to one authoritative process.

1. **Every runner is an edge node.** Its standalone executable contains the
   browser assets, serves a local app and API, keeps a workspace-scoped SQLite
   replica, and is the only executor for sessions assigned to it.
2. **Every browser profile is a local replica; every open tab is a peer.** The
   profile stores authorized workspace projections and an operation outbox in
   IndexedDB. Same-origin tabs coordinate through `BroadcastChannel`; tabs can
   connect outward to a runner or engine over WebSocket and, after signaling, to
   other tabs over WebRTC data channels. A tab never needs an inbound listener.
3. **The sync engine remains a privileged but nonessential peer.** It is the
   online authority for Google identity, device admission and revocation,
   credential provisioning, update publication, peer rendezvous, backup, and
   relay. It is not the merge leader for ordinary replicated data and is not in
   the execution path of a runner-owned session.
4. **Replication uses a typed, append-only operation log.** Operations have
   UUIDv7 IDs, per-device sequence numbers, causal frontiers, hybrid logical
   clocks, workspace scope, schema versions, and signatures. SQLite and
   IndexedDB are materialized projections. Domain-specific CRDT rules handle
   multi-writer state; generic last-write-wins is not applied to an entire SQL
   row.
5. **A session has exactly one execution authority.** Its assigned runner owns
   an execution epoch and alone may append canonical transcript, status, usage,
   and tool-result operations for that epoch. Inputs may be authored anywhere,
   but they are requests until that runner accepts them. There is no automatic
   takeover of an unreachable runner: transfer needs a signed handoff, and a
   dead runner is recovered by forking rather than risking two model turns or
   duplicated filesystem side effects.
6. **Secrets use a separate channel and store.** Replicated credential records
   contain summaries and availability only. Provider and Brave secrets never
   enter the browser, operation log, peer directory, WebRTC channel, ordinary
   runner-to-runner sync, logs, or app bundle. To execute while the engine is
   down, an explicitly authorized runner receives a device-encrypted credential
   envelope and keeps it in a private local vault. No other runner receives it
   transitively.

The availability guarantee is therefore precise: loss of the sync engine does
not stop an already authorized peer island. A tab and its reachable runners
continue locally and directly; disconnected islands converge later. No design
can create a new path through a failed NAT relay, a powered-off runner, or a
failed model provider. Remote operation during an engine outage needs an already
established direct path, a reachable runner URL, a LAN or VPN path, or an
independently operated encrypted relay.

## Current architecture and constraints

The current implementation is server-centric, despite the product description
already saying local-first:

- `sync-engine/index.ts` opens the Bun SQLite database, builds the Vite client,
  renders pages, builds runner executables, constructs auth/provider/session
  integrations, and starts the one `Bun.serve` process. `sync-engine/server.ts`
  routes the HTTP APIs and serves `/app`, `/app.js`, and `/styles.css` from
  in-memory build output. `sync-engine/client-build.ts` identifies
  `solid/client.tsx` as the Vite entry, while `sync-engine/pages.ts` loads the
  Solid SSR page code in `solid/pages.tsx`.
- Browser state starts by reading `/api/auth/session` in `solid/client.tsx`.
  `solid/realtime-client.ts` then connects to the same-origin `/api/realtime`,
  queues command envelopes in memory, and reconnects to that same URL. It does
  not persist application state in IndexedDB; the only current browser
  persistence found in `solid/` is transcript filter preferences in
  `solid/session-controller-transcript.ts`.
- `sync-engine/realtime.ts` upgrades both browser `/api/realtime` and runner
  `/api/runner/realtime` sockets. It authenticates a browser with the engine
  cookie, checks browser `Origin`, revalidates the user, sends runner/session
  snapshots, and dispatches commands. `sync-engine/realtime-hub.ts` is an
  in-memory fan-out hub. The shared routes are defined in `shared/routes.ts`;
  command IDs and idempotency keys are already part of
  `shared/user-realtime-protocol.ts`.
- The standalone process in `runner/runner-agent.ts` only dials outward to the
  engine with a bearer setup token. It executes commands from that socket,
  reports output, heartbeats every 15 seconds, reconnects, and checks for an
  update at startup and every five minutes. It does not currently serve the app,
  keep session state, call an LLM, or accept a browser connection.
- Agent orchestration currently runs in the engine. `sync-engine/sessions.ts`
  creates `SessionLauncher`, `SessionRuntimes`, the Drizzle `SessionStore`, the
  provider-backed model, and a `RunnerCommandBroker`. The broker sends only
  `RunnerToolCommand` values from `shared/runner-command-broker.ts` to the
  runner. `sync-engine/session-launcher.ts` passes a decrypted credential into
  the engine-side model runtime; `sync-engine/agent-model.ts` constructs the
  provider authorization header.
- Durable application state is relational. `shared/database.ts` opens and
  migrates Bun SQLite through Drizzle. `shared/database/schema.ts` defines
  users, workspaces, prompts, encrypted provider credentials, runners, sessions,
  turns, pending inputs, questions, and messages. Application tables use the
  audit columns in `shared/database/audit-columns.ts`, including `isDeleted`;
  IDs come from the UUIDv7 generator in `shared/ids.ts`. The schema already
  enforces one active turn per session and tracks
  `agent_sessions.execution_generation`, useful foundations for executor epochs.
- Google OIDC and the seven-day engine cookie are implemented in
  `sync-engine/auth.ts`; PKCE/cookie helpers are in `sync-engine/oauth.ts` and
  `sync-engine/http.ts`; sessions are stored by `sync-engine/auth-store.ts`.
  Runner setup tokens are bearer credentials parsed by `sync-engine/runners.ts`
  and stored as scrypt hashes plus lookup digests by
  `sync-engine/runner-token.ts` and `sync-engine/runner-store.ts`.
- Provider secrets are encrypted in `shared/database/schema.ts`'s
  `provider_credentials.encrypted_credential`. `shared/credential-cipher.ts`
  uses context-bound AES-256-GCM, and `shared/provider-credential-store.ts` only
  returns plaintext to an internal credential read. Engine integrations obtain
  their encryption keys from the `OPENAI_CREDENTIAL_KEY`,
  `OPENROUTER_CREDENTIAL_KEY`, `GENERIC_CREDENTIAL_KEY`, and
  `BRAVE_SEARCH_CREDENTIAL_KEY` environment variables. Collection responses
  return summaries, not secrets. Removal clears the ciphertext while
  soft-deleting the row. This boundary must not be weakened by replication.
- Production imports have four enforced roots. The rule in `eslint.config.ts`
  allows `solid/`, `sync-engine/`, and `runner/` to import themselves and
  `shared/`; `shared/` cannot import another workspace. A runner-local
  coordinator therefore cannot import engine orchestration. Runtime-neutral
  domain, protocol, and agent-loop pieces must move to `shared/`, while HTTP,
  storage, and host adapters remain in their owning workspace.

Today an engine outage removes the browser API, the realtime hub, session/model
orchestration, runner command delivery, and the runner's update endpoint at
once. Caching only the JavaScript would not address that dependency.

## Target topology

```text
                    Google / update / optional relay
                                 |
                    +------------v-------------+
                    | sync engine peer         |
                    | identity, admission,     |
                    | credential provisioning, |
                    | replica, rendezvous      |
                    +------+-------------+-----+
                           | peer sync    |
                    direct |              | direct
              +------------v--+        +--v------------+
              | runner A edge |<------>| runner B edge |
              | app + API     |        | app + API     |
              | SQLite + blobs|        | SQLite + blobs|
              | session exec  |        | session exec  |
              +---^---------^-+        +--^----------^-+
                  |         |             |          |
              WebSocket  runner sync   WebSocket  runner sync
                  |                         |
              +---+------+   WebRTC   +----+-----+
              | tab/profile|<-------->| tab/profile|
              | IndexedDB  |          | IndexedDB  |
              +------------+          +------------+
```

A connection is always between authenticated peers. “Peer-to-peer” does not mean
every peer has the same power:

| Peer                | Durable state                                                                                 | May execute a session                 | Privileged operations                                                                            |
| ------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Runner edge         | Authorized workspace log/projection, blobs, credential envelopes explicitly provisioned to it | Yes, only for epochs it owns          | Local directory/tool access; graceful authority handoff                                          |
| Browser profile/tab | Authorized workspace projection, local outbox, app cache; no provider secret                  | No                                    | Submit requests and multi-writer user data within its grant                                      |
| Sync engine         | Full authorized replica and backup, trust registry, encrypted credential store                | Legacy sessions during migration only | Google identity, device grants/revocation, secret provisioning, release signing, directory/relay |

The engine's privileged operations are signed control-plane records. Its normal
session, message, workspace, and prompt replicas use the same convergence rules
as other peers; reconnecting does not make its older SQL rows win.

## Authority and data boundaries

The design separates three kinds of state rather than pretending all SQL rows
are one CRDT:

- **Immutable or convergent data:** entity creation, canonical messages,
  content-addressed attachments, prompt/workspace fields, soft-delete
  tombstones, and pending input requests replicate through typed operations.
- **Executor-owned state:** a session runner, execution epoch, turn sequence,
  transcript output, status, usage, and tool side effects have one writer. Other
  peers can cache and relay them but cannot author them.
- **Control-plane and secret state:** user identity, runner/browser admission,
  revocation, workspace security grants, credential mutation, and credential
  envelopes are issued by the engine. Ephemeral presence, model deltas, and tool
  stream frames are not durable CRDT state.

The full operation format, entity-by-entity conflict rules, handoff protocol,
anti-entropy flow, and reconciliation behavior are specified in
[replication.md](local-first/replication.md).

## Required invariants

Implementation stages must preserve these properties:

1. Applying an operation or snapshot twice has no effect after the first
   application.
2. Two honest replicas with the same authorized operation set materialize the
   same user-visible state, independent of delivery order.
3. Wall-clock time alone never chooses a winner. Existing `createdAt` and
   `updatedAt` remain audit/presentation values; causal order and a persisted
   hybrid logical clock decide conflicts.
4. Every canonical model/tool message names one session execution epoch and is
   signed by that epoch's authority. Stale or non-authority output is
   quarantined, not merged into the transcript.
5. An input shown as “queued locally” is not shown as accepted or executed until
   an authority receipt exists. Existing command/idempotency concepts in
   `shared/user-realtime-protocol.ts` are retained and made durable.
6. Deletes remain tombstones and materialize through `isDeleted`; application
   data is never hard-deleted merely because a replica no longer shows it.
7. UUIDv7 entity IDs remain stable across replicas. Device sequence and clock
   metadata augment IDs rather than replacing them.
8. A peer receives only workspaces in its signed grant. Presence or mDNS never
   discloses workspace names, user email, paths, prompt text, session titles, or
   provider identities.
9. Provider plaintext and encrypted credential payloads never cross a browser
   boundary or ordinary replication boundary. A runner cannot forward a
   provisioned envelope to another runner.
10. Version skew fails closed for writes while retaining a compatible read-only
    view. Updating the engine is never required merely to open the app copy
    already stored on a runner.

## Product behavior when the engine is absent

With a reachable, paired runner and a locally provisioned credential, users can
open that runner's app, read replicated history, create or continue a session on
that runner, steer or stop its active session, answer questions, spawn onto a
reachable authorized runner, browse that runner's directories, and edit the
prompt bank. Provider internet access is still required for a hosted LLM; the
engine is not.

With no runner reachable, an already loaded or installed app can read its
IndexedDB replica, edit convergent user data, preserve drafts, and queue input
requests. It cannot honestly claim to start, steer, stop, compact, browse files,
or run a model. A never-installed browser cannot obtain code from an offline
host.

Google sign-in, first-time device enrollment, revocation, runner/credential
administration, OAuth connection, secret provisioning, and update download stay
unavailable until the engine returns. The complete matrix and required status
indicators are in
[trust-and-security.md](local-first/trust-and-security.md#degraded-mode-contract).

## Success criteria

The epic is complete only when automated outage tests demonstrate all of the
following, not merely when assets are cached:

- Kill the engine while a runner-owned model turn is active; the turn and local
  tool calls finish, persist on that runner, and remain controllable from its
  paired app.
- Open a fresh tab from the reachable runner while the engine is down and read
  its sessions without an engine cookie.
- Create, steer, answer, stop, continue, and same-runner spawn while the engine
  process is absent; no provider secret appears in browser, peer-sync, runner
  command, or logging captures.
- Partition two authorized peer islands, make supported concurrent changes, and
  verify deterministic convergence after direct sync and after the engine
  returns.
- Attempt a concurrent executor takeover and verify that the second runner can
  only fork, not append to the original execution epoch.
- Run supported adjacent app/protocol versions and verify read compatibility,
  explicit write fencing, asset cache invalidation, and recovery after update.
- Exercise loopback, LAN, and manual remote addressing with authentication,
  exact origin/host checks, revocation propagation, malformed operation limits,
  and DNS-rebinding tests.

The staged path to those criteria is defined in
[implementation.md](local-first/implementation.md).
