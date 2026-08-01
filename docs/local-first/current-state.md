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

## Current identity and provider authorization

- Google OIDC/engine cookies live in `sync-engine/auth.ts`. Target Google login
  becomes optional account linking, entitlement, and recovery rather than local
  product admission.
- Runner `qmr_…` tokens are parsed/stored by engine runner modules. They cannot
  become browser passwords, peer identities, anonymous trust roots, or backup
  capabilities.
- Provider secrets live in `provider_credentials.encrypted_credential` under
  engine environment keys; engine integrations decrypt/use them. Copying this
  field into ordinary replicas would violate secret boundaries and would not
  make it usable with runner keys.

Repository inspection also establishes what provider OAuth migration must
remove:

- `sync-engine/openai.ts` implements authorization-code/PKCE, token refresh, and
  a default public client redirect of `http://localhost:1455/auth/callback`.
  `sync-engine/index.ts` attempts to start that second localhost server. The
  production engine's localhost is not the user's runner, so target OpenAI
  authorization is runner-side device code and the listener/engine callback path
  is deleted.
- `sync-engine/openrouter.ts` sends a caller-derived `callback_url`, uses PKCE,
  and exchanges the code for a key. It has no client ID/secret configuration;
  only optional callback URI and encryption-key settings exist. Therefore it is
  callback-bound but not engine-bound. The target runner hosts the callback and
  exchange; engine OpenRouter OAuth is deleted.
- Google genuinely uses the engine's registered callback and remains the sole
  engine-hosted OAuth/OIDC flow. Shared OAuth helpers still needed by Google are
  retained rather than indiscriminately deleting `oauth.ts`.

Detailed target flows and exact removal scope are in
[credentials.md](credentials.md#what-the-migration-deletes). Legacy OpenAI OAuth
migration assumes device-code re-authentication rather than designing new engine
custody.

## Repository boundaries

Production imports have four enforced roots. `solid/`, `sync-engine/`, and
`runner/` may import themselves and `shared/`; `shared/` imports no other
workspace. Runner coordination/provider code cannot import engine modules.
Runtime-neutral domain operations, peer/credential protocols, crypto interfaces,
and agent/provider pieces move to `shared/`; HTTP/storage/platform/discovery
adapters stay in their roots.

Migration adapters may expose old engine records as partitioned operations or
legacy views, but cannot establish a second authority. Each legacy write must
cross the same transactional operation/projection boundary before convergence is
claimed. Temporary export/bridge/provider routes are removed at cutover; none
count as the peer-first target.
