# Current architecture and migration constraints

This document records the server-centric starting point and code boundaries for
the staged [local-first architecture](../local-first-architecture.md).

## Current request and execution path

- `sync-engine/index.ts` opens SQLite, builds the Vite client, renders pages,
  builds runners, constructs auth/provider/session integrations, and starts one
  `Bun.serve`. `sync-engine/server.ts` serves `/app`, `/app.js`, and
  `/styles.css`; `solid/client.tsx` is the browser entry.
- Browser startup reads `/api/auth/session`, so Google login is currently
  mandatory. `solid/realtime-client.ts` connects to same-origin `/api/realtime`,
  queues only in memory, and has no shared IndexedDB replica.
- `sync-engine/realtime.ts` terminates browser and runner sockets and
  `sync-engine/realtime-hub.ts` fans out in memory. This broker role is removed.
- `runner/runner-agent.ts` dials outward using a bearer setup token, executes
  commands, reports heartbeats/output, and updates. It serves no app, owns no
  account/session projection, calls no model, and accepts no peers.
- Agent orchestration and plaintext provider use run in the engine. Only tool
  commands cross to the runner.

Thus engine outage currently removes UI/API, auth, fan-out, orchestration,
command delivery, and update source. Asset caching alone cannot satisfy #46. The
target Solid client remains a browser client but shifts to bounded on-demand
views from runners; it does **not** become a full replica.

## Current persistence and exact tier partition source

`shared/database/schema.ts` currently exports these entities:

- non-session account/configuration: `users`, `workspaces`, `prompts`,
  `provider_credentials` (sanitized in the target), `provider_quota_settings`,
  `provider_quota_reset_receipts`, `provider_credential_workspaces`,
  `attachment_fallbacks`, `runners`, and `runner_workspaces`;
- session data: `agent_sessions`, `agent_session_turns`, `agent_pending_inputs`,
  `agent_question_requests`, and `agent_messages`; and
- engine web-login control: `sessions`, whose token rows are not agent session
  history and must not replicate.

The normative field/blob treatment and free/paid matrix are in
[replication.md](replication.md#engine-backup-partition-by-schema-entity).
Current audit columns/soft deletes and UUIDv7 IDs are useful, but rows are not a
convergent log. `agent_sessions.execution_generation` and active-turn invariants
help execution epochs but do not establish peer authority.

Today the same engine database is readable and authoritative for all users;
there is no anonymous account mode, tier entitlement, partitioned backup
frontier, or total-runner-loss restore protocol. Migration must first preserve
stable IDs/tombstones and then make the engine an independent readable
subscriber. Free session rejection must occur before durable storage/ack, not by
hiding rows at query time.

## Current identity, credentials, and connectivity

- Google OIDC and engine cookies live in `sync-engine/auth.ts`. Target Google
  login becomes optional account linking, entitlement, and recovery rather than
  local product admission.
- Runner `qmr_…` tokens are parsed/stored by engine runner modules. They cannot
  become browser passwords, peer identities, anonymous trust roots, backup
  capabilities, or mesh candidate topics.
- Provider secrets live in `provider_credentials.encrypted_credential` under
  engine environment keys; engine integrations decrypt/use them. Copying this
  field into ordinary replicas would violate secret boundaries and would not
  make it usable with runner keys.
- `sync-engine/openai.ts` implements authorization-code/PKCE, refresh, and a
  default `http://localhost:1455/auth/callback`; target OpenAI uses runner
  device code and deletes this engine path.
- `sync-engine/openrouter.ts` uses caller-supplied callback URL plus PKCE and no
  client secret, so its target callback/exchange runs on the runner. Google
  remains the sole engine-hosted OIDC flow. Exact removal scope is in
  [credentials.md](credentials.md#what-the-migration-deletes).
- There is no private-mesh candidate gossip, observed-address/punch protocol,
  member relay, anchor health model, admission/manual offer package, or
  opportunistic router mapping today. Current application WebSockets are not a
  peer-discovery primitive and must never be relabeled as a peer route.

The target puts those functions in runners and the existing linked engine
subscriber rather than adding a dedicated rendezvous component. Admitted members
exchange address material only over encrypted member channels; a one-use
onboarding package carries current candidates before admission. A stable
home/VPS runner or linked engine subscriber is an anchor, members relay for one
another, and the paid engine relay remains a convenience. Public STUN, public
DHT, and standalone/community rendezvous are intentionally not migration
prerequisites or target paths.

## Repository and migration boundaries

Production imports currently have four enforced roots. `solid/`, `sync-engine/`,
and `runner/` may import themselves and `shared/`; `shared/` imports no other
workspace. Runtime-neutral operations, peer/credential and private mesh-control
wire formats, crypto interfaces, and agent/provider pieces move to `shared/`;
HTTP, storage, and platform networking adapters stay in their owning runtime.
Runner coordination/provider code cannot import `sync-engine/`. No new
standalone production root is needed for mesh connectivity.

Migration adapters may expose old engine records as partitioned operations or
legacy views, but cannot establish a second authority. Each legacy write must
cross the same transactional operation/projection boundary before convergence is
claimed. Temporary export/bridge/provider routes are removed at cutover. The
legacy engine application socket, even during migration, never satisfies remote
first contact or the peer-first data-plane target.
