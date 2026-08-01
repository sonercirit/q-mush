# Trust, login, recovery, and security

This document is normative detail for the
[local-first architecture](../local-first-architecture.md). Topology is in
[runtime-and-transport.md](runtime-and-transport.md), replication/tier scope in
[replication.md](replication.md), and secret flows in
[credentials.md](credentials.md).

## Anonymous-first identity and peer trust

### Runner-local account genesis

Login is optional. On first local use, a runner can create an **anonymous local
account** without contacting the engine:

- generate a stable random account UUIDv7, Ed25519 owner signing key, X25519
  encryption key, and random device ID distinct from machine fingerprint;
- write a signed account-genesis operation naming that owner and recovery state
  `none`;
- initialize the complete runner operation/projection/blob stores; and
- issue a short-lived origin-bound browser client grant after local physical
  confirmation.

The private owner/device keys never leave an authorized device. Runner keys use
mode `0600` and OS keychain/secure hardware where available, with a sealed-file
fallback. Browser client keys may be non-extractable WebCrypto keys, but they
only authenticate a partial view client; they do not make the browser a replica
or owner unless an explicit high-risk owner grant says so.

Anonymous mode supports local app access, sessions, providers, tools, all-runner
replication, manual/LAN/VPN peer discovery, and direct pairing among the user's
devices. It has no engine identity, backup, managed rendezvous/relay, or total-
runner-loss recovery. That loss posture is accepted and shown before destructive
retirement of the last runner.

### Peer grants

An authorized owner can directly:

- approve a runner or browser key after fingerprint/user confirmation;
- issue grants no wider than its capabilities;
- renew devices, add an owner with high-risk confirmation, and sign remove-wins
  revocations; and
- gossip trust operations to reachable runners and the entitled backup.

No routine action needs the engine. A runner membership grant commits it to the
full account replica. Workspace capabilities constrain access/execution/secret
use, not runner storage. Browser grants authorize bounded view queries/commands
and never include full-replica, compaction, backup, vault, or execution
capabilities. Multi-account runners isolate keys and data.

Grants expire. An offline device accepts only an unexpired chain not rejected by
its latest revocation frontier and cannot self-renew. Persist highest trusted
clock state so rollback fails writes closed while cached reads remain. A
partitioned revoked device may retain authority until expiry; UI shows expiry
and frontier age.

## Optional Google login and lossless linking

Google login gates engine features; it does not gate the product. The engine's
Google OIDC authorization-code/PKCE flow validates external identity, creates a
short-lived engine web session, and discards provider tokens. It has no
authority over ordinary operations merely because a user logged in.

To link an anonymous account:

1. The owner runner starts Google login with a nonce binding its stable account
   ID, owner public key, engine origin, and requested tier.
2. After callback, the engine presents the verified Google subject and any
   existing Q Mush account identity. The runner signs acceptance of the binding;
   the engine signs a bootstrap assertion binding Google subject, account ID,
   owner key, tier, and expiry.
3. That assertion becomes an auditable trust-root binding operation. Existing
   operations, IDs, sessions, blobs, keys, and peer grants are unchanged.
4. The runner receives an entitlement-scoped backup capability and backfills the
   non-session partition for free or both partitions for paid. Engine features
   remain `linking/backing up` until the verified frontier completes.

If that Google subject already owns an engine-backed account, silently replacing
or renumbering either side would not be lossless. Require explicit merge/import:
restore the remote frontier into a temporary namespace, preserve
operation/entity IDs and provenance, dedupe identical hashes, apply domain
convergence, and stop on ID equivocation or incompatible trust roots. The user
chooses the surviving account identity/trust-root transition with recovery
confirmation. No local data is deleted merely because login succeeds or fails.

Logging out deletes the engine browser session/capability but does not erase the
local account or disable runner-local operation. “Unlink account” is a separate
high-risk action with backup/tier consequences; it cannot silently turn an
engine-backed account anonymous while leaving ambiguous recovery ownership.

### Pairing paths

1. **Owner-device pairing:** joining key/challenge, direct authenticated path,
   displayed fingerprints, explicit approval, bounded signed grant.
2. **Local physical pairing:** transcript-bound PAKE-style QR/code exchange and
   confirmation. A non-owner runner may introduce but not grant.
3. **Google recovery/bootstrap:** engine signs only a short-lived assertion
   after login; a fresh runner records the trust transition and restores
   entitled backup.
4. **Returning browser client:** device-key challenge followed by a short-lived,
   origin-bound HttpOnly runner cookie and WebSocket proof.

Codes expire in minutes, are single-use/rate-limited, and bind the transcript.
Never place durable bearer tokens in URLs, QR codes, `localStorage`, bundles, or
logs. State-changing HTTP requires exact `Host`/`Origin`, CSRF, and client
grant; WebSockets require origin and signed nonce. The legacy `qmr_…` runner
token is retired after device-key migration and never becomes a browser
password.

## Engine identity, entitlement, and backup trust

The engine signs separate key purposes for Google binding/recovery,
entitlement-scoped backup capabilities, and release publication. None can sign a
device grant, operation, credential, or session epoch. A free capability permits
only non-session backup; paid permits both partitions and managed
rendezvous/relay. Entitlement is checked server-side on every bounded backup
transaction, not trusted from clients.

The backup is default-on for a linked account and readable by the engine. This
is a conscious confidentiality tradeoff for total-runner-loss recovery, not
blind storage. Operators must protect account isolation, authorization,
encryption at rest/in transit, audited access, retention, and purge. Secrets
remain excluded. For replication the engine is a normal peer subscriber that
validates and acknowledges its entitled frontier, including partition-scoped
safety/compaction. It is never a bridge, execution authority, or ordinary route.
Browsers never acknowledge a frontier or count toward any quorum.

Peer handshakes prioritize revocations before application data. Sensitive owner
or credential-policy changes may require a maximum revocation age; without a
fresh enough owner peer they fail closed rather than consulting engine
authority.

## Recovery matrix

“Data” below means ordinary application data; provider vault secrets have their
own recovery policy.

| Mode            | Identity/root               | Engine service                                              | Total runner loss                                                                                                                                                        | Browser cache role                        |
| --------------- | --------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| Anonymous       | Device-key account genesis  | None                                                        | **All shared data and secrets lost. Accepted.**                                                                                                                          | None; partial cache is not restore input. |
| Logged in, free | Device root bound to Google | Default readable non-session backup                         | Restore account, workspaces, prompts, runner/trust registry, credential summaries/configuration; **all session entities and session-only blobs lost by business policy** | None.                                     |
| Logged in, paid | Device root bound to Google | Default readable full ordinary backup plus rendezvous/relay | Restore all ordinary records, sessions, tombstones, and application blobs through acknowledged frontier                                                                  | None.                                     |

A fresh recovery runner authenticates with Google, verifies the recovery
assertion, creates new device keys, records a visible trust-root transition,
revokes lost devices, and restores the entitled snapshot/tail. It remains
`joining` until hashes/frontiers verify. Free mode explicitly initializes an
empty session partition rather than pretending missing history is corruption.
Credential summaries can identify what needs re-entry/re-authorization but
cannot recreate vault values. A write not yet acknowledged by another runner or
the entitled engine remains outside the promise.

Tier transitions are defined in
[replication.md](replication.md#tier-transitions-and-restore). Downgrade stops
session backup immediately; proposed 30-day quarantined retention before purge
is open question 15. Runner copies remain full in every tier.

## Degraded-mode contract

A hosted model still needs its provider network. A fresh browser needs a runner
to load code/views; an installed partial cache is not an executor.

| Action                               | Engine down, ready runner reachable          | Cached Solid client, no runner       | Contract                                               |
| ------------------------------------ | -------------------------------------------- | ------------------------------------ | ------------------------------------------------------ |
| Open app                             | Yes, embedded release                        | App shell/cached views only          | Runner is the normal host.                             |
| Read all shared data/attachments     | Yes, full runner                             | Cached partial views only            | Browser cache never proves completeness.               |
| Commit prompt/workspace/session edit | Yes, runner operation                        | No; preserve draft                   | Shared commit starts at a runner.                      |
| Create/continue/steer/answer/stop    | With authority, grant, vault, provider       | No                                   | Executor receipt controls state.                       |
| Browse/run tools                     | On selected runner                           | No                                   | Filesystem stays external/local.                       |
| Pair/renew/revoke                    | With owner peer                              | No, unless connected as owner client | Peer trust operation.                                  |
| Add/rotate API/generic/Brave         | Enter at runner; direct distribution         | No                                   | Zero engine requests.                                  |
| OpenAI device authorization          | Yes, runner polls provider                   | No                                   | No callback or engine.                                 |
| OpenRouter connect                   | Yes, runner-local PKCE callback if reachable | No                                   | API key fallback; no engine bounce.                    |
| Google link/recovery                 | No                                           | No                                   | Existing local grants continue.                        |
| Runner replication                   | Direct links                                 | Not applicable                       | Browser is not a member.                               |
| Backup progress/restore              | Paused                                       | No                                   | Local operation continues; frontier shown.             |
| Managed rendezvous/relay             | No                                           | No                                   | Paid engine service only; direct/manual routes remain. |
| Update                               | Signed peer/mirror or current release        | Existing release                     | Engine hosting is one source.                          |

Engine loss disables Google linking/recovery, backup progress/restore, managed
rendezvous/relay, and engine-only releases. It does not disable ordinary runner
sync, execution, peer administration, provider connect, or user-entered secrets.

## Security analysis

A runner becomes app server, full replica, coordinator, trust participant, and
credential holder. It is high value. The readable engine backup also increases
operator-side data exposure for the entitled partition.

| Threat                               | Required mitigation/test                                                                                                                                                |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runner compromise                    | Treat as full account disclosure and granted writes; disk/vault encryption, least privilege, patching, lock, revoke, short grants, audit. Root is out of scope.         |
| Browser mistaken for durable replica | No browser frontier/ack capability; destroy-runner tests ignore IndexedDB; UI always says partial view.                                                                 |
| Engine readable-backup breach        | Account isolation, encryption, least-privilege operator access, audited reads, retention/purge, incident response; free scope limits sessions but is readable.          |
| Free entitlement bypass              | Engine-authoritative capabilities, semantic partition validation, mixed/unknown fail closed, split snapshots/manifests, restore filtering, transition revocation tests. |
| Engine becomes broker                | Route telemetry, no ordinary fan-out endpoint, healthy/blocked engine tests; relay opaque and labeled.                                                                  |
| Anonymous last-runner loss           | Persistent warning, optional encrypted export, destructive confirmation; never imply browser/engine recovery.                                                           |
| Account-link takeover/collision      | Nonce binds account/owner/origin, signatures both sides, explicit merge, stable IDs/provenance, no silent overwrite.                                                    |
| Credential compromise/leak           | Independent vault envelopes, separate keys/channel/store, target/policy binding, canary capture; see credentials design.                                                |
| DNS rebinding/hostile site           | Authenticate endpoints; exact `Host`/`Origin`; reject `null`; no wildcard CORS; CSRF; WebSocket proof.                                                                  |
| LAN interception                     | Pinned TLS/challenge-response; never trust RFC1918/`.local`; show fingerprints.                                                                                         |
| Pairing theft/delegation             | Transcript-bound PAKE, one-use code, confirmation, non-widening delegation, owner ceremony, rate limits.                                                                |
| Browser XSS                          | Strict CSP, unsafe-HTML lint, HttpOnly/SameSite cookie, non-extractable client key, no secret persistence.                                                              |
| Replica poisoning                    | Signatures, grants/epochs, monotonic sequence, causal/schema/size checks, quarantine, snapshot/blob hashes.                                                             |
| Split-brain effects                  | No timeout takeover; signed handoff/fencing; stale rejection; recovery fork; write-ahead tool start.                                                                    |
| Resource exhaustion                  | Reserve, bounded chunks/decompression/signatures, dedupe, quotas, reject oversized imports before commit.                                                               |
| False readiness                      | Signed frontier/blob-root challenge and local verification; no readiness role until complete.                                                                           |
| Offline revoked device               | Expiry, priority gossip, sensitive-change freshness, visible stale window, secret rotation.                                                                             |
| Update injection                     | Publisher signature, SHA-256, immutable assets, atomic rollback; source has no authorship.                                                                              |
| Discovery leak                       | Opaque ID/candidates/version only; authenticate before frontier; no path/session/provider labels.                                                                       |

Runner data at rest uses full-disk encryption and, where practical, a DB/blob
key sealed to OS storage. Vault keys remain separate. Engine backup needs server
encryption/access controls but cannot resist an authorized/compromised engine
process. User exports are encrypted and exclude vault data unless explicitly
created for credential recovery.

Retiring a runner transfers unique local data where possible, revokes
membership, and erases local keys. It cannot erase exfiltrated copies. Shared
deletion uses audited tombstones and tier-aware retention. Security logs contain
only IDs, kinds, sizes, routes, and result codes—not content, paths, endpoints,
tokens, or envelopes.

GitHub Security Lab's
[localhost/CORS/DNS-rebinding analysis](https://github.blog/security/application-security/localhost-dangers-cors-and-dns-rebinding/)
recommends authentication and approved `Host` checks. Loopback binding alone is
not a security boundary.
