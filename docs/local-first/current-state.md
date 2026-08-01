# Current architecture and migration constraints

This document supports the
[local-first architecture](../local-first-architecture.md) by recording the
server-centric starting point and code boundaries the staged migration must
respect.

## Current request and execution path

- `sync-engine/index.ts` opens the Bun SQLite database, builds the Vite client,
  renders pages, builds runner executables, constructs auth/provider/session
  integrations, and starts one `Bun.serve` process. `sync-engine/server.ts`
  routes HTTP APIs and serves `/app`, `/app.js`, and `/styles.css` from
  in-memory output. `sync-engine/client-build.ts` identifies `solid/client.tsx`
  as the Vite entry, while `sync-engine/pages.ts` loads `solid/pages.tsx`.
- Browser state starts by reading `/api/auth/session` in `solid/client.tsx`.
  `solid/realtime-client.ts` connects to same-origin `/api/realtime`, queues
  commands in memory, and reconnects to that URL. It does not persist shared
  application state in IndexedDB.
- `sync-engine/realtime.ts` terminates both browser and runner sockets,
  authenticates them, publishes snapshots, and dispatches commands.
  `sync-engine/realtime-hub.ts` is an in-memory fan-out hub. This is the broker
  role the target architecture removes.
- `runner/runner-agent.ts` only dials outward to the engine with a bearer setup
  token. It executes commands from that socket, reports output/heartbeats, and
  checks for updates. It does not serve the app, retain sessions, call an LLM,
  or accept peer connections.
- Agent orchestration runs in the engine. `sync-engine/sessions.ts` constructs
  session stores, provider model, and `RunnerCommandBroker`;
  `sync-engine/session-launcher.ts` passes a decrypted credential to the engine
  model runtime, and only tool commands cross to the runner.

Consequently an engine outage currently removes browser API, realtime fan-out,
model orchestration, command delivery, and the update endpoint together. Asset
caching alone cannot satisfy the epic.

## Current persistence, identity, and credentials

- `shared/database/schema.ts` defines users, workspaces, prompts, credentials,
  runners, sessions, turns, pending inputs, questions, and messages. Tables use
  audit columns from `shared/database/audit-columns.ts`, including `isDeleted`;
  IDs come from `shared/ids.ts`. One active turn per session and
  `agent_sessions.execution_generation` are foundations for execution epochs,
  but current rows are not a convergent operation log.
- Google OIDC and the engine cookie are in `sync-engine/auth.ts`. Runner setup
  tokens are parsed by `sync-engine/runners.ts` and stored as hashes/digests by
  `sync-engine/runner-token.ts` and `sync-engine/runner-store.ts`. Those bearer
  tokens cannot become browser passwords, peer identities, or account trust
  roots.
- Provider secrets currently live in `provider_credentials.encrypted_credential`
  under context-bound AES-256-GCM. Engine integrations read provider-specific
  environment keys and consume plaintext in the engine process; collection APIs
  return only summaries. Migration must move custody to runner device vaults
  through the sealed flow in [credentials.md](credentials.md). Copying current
  ciphertext into ordinary full replicas would violate the secret boundary and
  would not make it usable under runner keys.

## Repository boundaries

Production imports have four enforced roots. `solid/`, `sync-engine/`, and
`runner/` may import themselves and `shared/`; `shared/` cannot import another
workspace. A runner-local coordinator therefore cannot import engine
orchestration. Runtime-neutral domain operations, peer/credential protocols,
crypto interfaces, and agent-loop pieces move to `shared/`; HTTP, storage,
platform crypto, discovery, and host adapters remain with their owning
workspace.

Migration adapters may temporarily expose the old engine data as operations or
serve legacy sessions, but they cannot create a second authority. Each legacy
write must cross the same transactional operation/projection boundary before a
stage can claim convergence. Transitional export or bridge endpoints are removed
at cutover and never count as the peer-first target.
