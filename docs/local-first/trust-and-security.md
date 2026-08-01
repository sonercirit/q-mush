# Trust, degraded operation, and security

This document is normative detail for the
[local-first architecture](../local-first-architecture.md). Topology, discovery,
and app delivery are specified in
[runtime-and-transport.md](runtime-and-transport.md).

## Authentication and trust

### Device identity and grants

Google remains account bootstrap, not offline authentication. While the engine
is online and the user has a valid `q_mush_session` cookie from
`sync-engine/auth.ts`, enrollment creates:

- Ed25519 signing and X25519 encryption keys on the device;
- a random device ID, distinct from the machine fingerprint;
- an engine-signed certificate binding user ID, public keys, peer type,
  expiration, and serial;
- engine-signed workspace grants with capabilities and expiry; and
- the latest signed revocation checkpoint.

Private keys never leave the device. Runner keys stay mode `0600` under the
private runner home, with OS keychain protection where available and a sealed
private-file fallback. Browser profiles use non-extractable WebCrypto keys in
IndexedDB where supported. A profile, not each tab, is the durable browser peer.

Certificates must cover realistic outages but expire. An offline peer accepts
only an unexpired certificate/grant not rejected by its newest revocation
checkpoint; it cannot extend its own grant. Store the highest trusted time/HLC
so clock rollback fails new writes closed while retaining cached reads.

Revocation cannot instantly reach a partitioned device. The product contract is
**bounded stale authorization**: offline access lasts until grant expiry or a
newer revocation arrives. Sensitive actions may require online freshness. The UI
shows the exact offline-authorization expiry. The proposed duration is an open
product question.

### Tab-to-runner pairing

Serving assets is public; data is locked. First access to a runner origin shows
no replicated data and supports:

1. **Online pairing:** the signed-in engine has both devices approve a
   short-lived single-use challenge and issues grants.
2. **Local physical pairing:** runner CLI/UI displays a one-time code or QR; tab
   and runner use a transcript-bound PAKE-style exchange, show fingerprints, and
   require runner confirmation. It can grant only workspaces already delegated
   to that runner.
3. **Returning profile:** device-key challenge-response, then a short-lived,
   origin-bound HttpOnly runner cookie and WebSocket proof-of-possession.

Never put a durable bearer token in a URL, QR, `localStorage`, or bundle. Codes
expire in minutes, are single-use and rate-limited, and require the live
transcript. State-changing HTTP requests require exact `Origin`, CSRF, and
device authorization; WebSockets require exact origin and nonce signature.

The current `qmr_…` token in `runner/runner-agent.ts`, hashed by
`sync-engine/runner-token.ts`, authenticates runner to engine only. It is not a
browser password or mesh key. Enrollment rotates legacy setup material into
device credentials.

### Peer authentication

Runner/runner and engine/peer connections mutually sign nonce handshakes and
validate certificate chain, grant intersection, protocol, and revocation before
revealing frontiers. The authorized workspace set is the intersection of both
grants. The first implementation does not relay workspaces outside it.

The engine has pinned peer and control-plane keys. Privilege is
operation-specific: peers accept engine signatures for admission, revocation,
grants, credential envelopes, and release manifests—not arbitrary executor
output. Release, control, and secret-envelope keys are separate.

## Provider and skill secrets

Today `shared/credential-cipher.ts` encrypts records with per-provider
environment keys; `shared/provider-credential-store.ts` decrypts only internal
reads; `sync-engine/agent-model.ts` uses plaintext inside the engine process.
The target keeps that default and provisions runners explicitly:

- After online user authorization, the engine checks target runner scope and
  encrypts a credential envelope to its X25519 key. Associated data binds
  credential ID, target device, workspace, provider/base URL, version, expiry.
- The runner stores it in a private vault protected by OS keychain or a local
  wrapping key. No key lives in the web release.
- Browser APIs expose only summary and “available on this runner.” The app sends
  a credential ID; the runner model adapter opens the vault.
- OAuth refresh material follows the same rule. If it expires and refresh is
  engine-only, new execution waits for the engine. Device-side refresh needs a
  separate review.
- Brave Search follows the same provisioning policy. Generic base URLs are
  scope-private configuration and never discovery metadata.

Secrets never enter IndexedDB, service-worker cache, browser JavaScript values,
ordinary operation logs/snapshots/blobs, mDNS, peer lists, tab WebRTC channels,
runner tool commands, transcripts, diagnostics, bundles, or logs. Runners never
forward envelopes to one another; the engine provisions each target with user
consent. An unprovisioned runner cannot execute offline.

## Degraded-mode contract

A hosted LLM still needs its provider network; “engine offline” does not mean
“internet unnecessary.” A fresh browser also cannot load code from an
unreachable host.

| Action                                               | Engine down, assigned runner reachable                                                | Cached tab, no runner               | Contract                                                                    |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------- |
| Open app                                             | Yes, from embedded runner release                                                     | Only if previously installed/cached | Never promise a fresh app from an unreachable host.                         |
| Read sessions/messages/usage                         | Runner and tab replicas                                                               | Last IndexedDB projection           | Show frontier/last sync and missing blobs.                                  |
| Edit prompt bank/workspace names                     | Yes                                                                                   | Yes                                 | Commit locally; show unsynced/conflict state. Security grants are excluded. |
| Preserve draft/preferences                           | Yes                                                                                   | Yes                                 | Local only; never an accepted input.                                        |
| Create session                                       | If grant and credential envelope are valid                                            | No                                  | Runner accepts durably and becomes epoch-zero authority.                    |
| Continue/follow up/steer/answer                      | If that executor is reachable                                                         | Queue request only                  | “Queued locally” until executor receipt; cancellable before receipt.        |
| Stop active session                                  | Direct to executor                                                                    | Queue request, not stopped          | Warn work may still run.                                                    |
| Spawn child                                          | Same runner; another only if directly reachable, granted, compatible, and provisioned | No                                  | No hidden route through stale engine state.                                 |
| Compact/change executor config                       | At executor boundary                                                                  | Queue or unavailable                | Preserve epoch/generation fencing.                                          |
| Browse directories/run tools                         | On paired reachable runner                                                            | No                                  | Never present cached filesystem data as live.                               |
| Reassign                                             | Graceful handoff between reachable runners                                            | No                                  | Unreachable source offers recovery fork only.                               |
| Discover peers                                       | Cached/manual/LAN/reachable rendezvous                                                | Cached/manual/WebRTC                | NAT may leave no route.                                                     |
| Google login/device enrollment                       | No                                                                                    | No                                  | Existing unexpired grant only.                                              |
| Change runners/grants/credentials/OAuth/provisioning | No                                                                                    | No                                  | Engine control action; queued intent is not effective.                      |
| Download update                                      | Existing release continues                                                            | Existing release continues          | Needs engine or configured signed mirror.                                   |
| Hosted LLM call                                      | If provider and vault credential work                                                 | No executor                         | Report provider separately from engine.                                     |

Supported offline execution includes create, view, continue, follow-up, steer,
stop, question answers, compaction, prompt-bank edits, directory access, and
same-runner spawn on a reachable authorized runner. Multi-runner spawn requires
a direct path and all target prerequisites. Google/OAuth/admission/revocation,
credential changes/provisioning, and first install remain control-plane-only.

## Security analysis

A runner changes from outbound-only worker to HTTP/WebSocket server, replica,
coordinator, and credential holder. Treat it as a high-value service.

| Threat                                       | Required mitigation/test                                                                                                                                   |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DNS rebinding/hostile site attacks local API | Authenticate every sensitive endpoint; exact allowlisted `Host`/`Origin`; reject `null`; no reflective/wildcard CORS; CSRF; WebSocket nonce proof.         |
| LAN interception/MITM                        | Pinned TLS and device challenge-response; never trust RFC1918/`.local`; show fingerprint.                                                                  |
| Pairing theft/brute force                    | Transcript-bound PAKE, minutes-long single use, backoff, runner confirmation, audit; no durable bearer URL.                                                |
| Browser XSS steals capability/secret         | Strict self/hash CSP, existing unsafe-HTML lint, HttpOnly/SameSite cookie, non-extractable key, short session, no browser secrets, escaped output.         |
| Peer forges state                            | Canonical signatures, grant/epoch checks, monotonic device sequence, causal/schema/size validation, quarantine/equivocation alert.                         |
| Replay/duplicate command                     | Durable operation ID/idempotency receipt, connection nonce, device sequence/expiry; executor receipt wins.                                                 |
| Split-brain duplicates model/tool effects    | No timeout takeover; signed handoff/epoch fencing; reject stale epoch; recovery fork; write tool-start before execution and never blindly retry ambiguity. |
| Cross-workspace exfiltration                 | Scoped grants, logs, snapshots, blobs, projections; reveal no frontier before mutual auth; adversarial scope tests.                                        |
| Secret leakage                               | Separate envelope/vault; target binding; redaction; canary capture tests across HTTP, storage, sync, WebRTC, logs, crashes, bundles, commands.             |
| Disk/CPU exhaustion                          | Per-peer/workspace quotas, envelope/blob/decompression limits, causal-gap/signature budgets, flow control, hash verification, safe GC.                     |
| Malicious mDNS advert                        | Discovery is a hint; cryptographically pair/pin; TXT has no private metadata or authority.                                                                 |
| Offline revoked device                       | Bounded expiry, signed revocation gossip/checkpoints, online freshness for sensitive control, visible stale window.                                        |
| Clock attack                                 | Causal HLC/device tie-break, forward-jump quarantine, trusted-time rollback guard; suspicious clocks fail writes closed.                                   |
| Compromised engine authors transcript        | Separate engine keys; no runner-epoch executor certificate; no blanket engine privilege for ordinary data.                                                 |
| Update injection                             | Installer-rooted manifest signature, SHA-256, immutable assets, atomic rollback; reject code from discovered peers.                                        |
| Local process reads runner state             | Private files, OS keychain, loopback default, no secrets in command line/environment dumps/logs. Root/admin is out of scope.                               |

Security logs contain IDs, kinds, sizes, and rejection codes—not prompt content,
paths, tokens, or plaintext envelopes. “Forget browser” and “erase local
replica/vault” cryptographically erase that device. Application entities still
follow the repository's soft-delete audit policy.

GitHub Security Lab's
[localhost/CORS/DNS-rebinding analysis](https://github.blog/security/application-security/localhost-dangers-cors-and-dns-rebinding/)
recommends authentication and approved `Host` checks. Loopback binding is not a
security boundary.
