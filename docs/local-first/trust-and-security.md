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
replication, and direct pairing among the user's devices. Remote first contact
may use a configured standalone/community rendezvous and relay or manual
public-STUN offer/answer exactly like free mode; these paths never require login
or entitlement. Anonymous mode has no engine identity, backup, **managed**
connectivity service, or total-runner-loss recovery. That loss posture is shown
before destructive retirement of the last runner.

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

1. **Owner-device pairing:** a joining key/challenge, discovered over any route,
   displayed fingerprints, explicit approval, and bounded signed grant. For
   remote first contact, a one-use package carries a high-entropy rendezvous
   secret plus standalone service URL, or a manual ICE offer; rendezvous creates
   a route but cannot approve the device.
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
entitlement-scoped backup capabilities, managed-connectivity admission, and
release publication. None can sign a device grant, operation, credential, or
session epoch. A free capability permits only non-session backup; paid permits
both partitions and the managed rendezvous/relay deployment. Standalone
connectivity uses the same wire protocol but its own operator policy and no Q
Mush entitlement; it is not an engine trust assertion. Entitlement is checked
server-side on every bounded backup or managed-service transaction, not trusted
from clients.

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

| Mode            | Identity/root               | Engine service                                                             | Total runner loss                                                                                                                                                        | Browser cache role                        |
| --------------- | --------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| Anonymous       | Device-key account genesis  | None                                                                       | **All shared data and secrets lost. Accepted.**                                                                                                                          | None; partial cache is not restore input. |
| Logged in, free | Device root bound to Google | Default readable non-session backup                                        | Restore account, workspaces, prompts, runner/trust registry, credential summaries/configuration; **all session entities and session-only blobs lost by business policy** | None.                                     |
| Logged in, paid | Device root bound to Google | Default readable full ordinary backup; paid managed connectivity available | Restore all ordinary records, sessions, tombstones, and application blobs through acknowledged frontier                                                                  | None.                                     |

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

The UI reports independently: runner route, discovery source/operator, direct or
relay transport, runner completeness, executor/vault/provider state, and engine
backup frontier. It never collapses discovery into authorization or a relayed
route into backup.

A hosted model still needs its provider network. A browser cache is not an
executor. With the engine down, a ready runner can open the embedded app; read
all data; commit edits; execute/steer/stop; browse tools; administer peers;
provision credentials; and run OpenAI device or reachable OpenRouter PKCE flows.
Google link/recovery and backup progress pause. Without a runner, Solid only
shows cached partial views/drafts and commits nothing.

Remote first contact remains available through direct/LAN/VPN routes,
standalone/community rendezvous and relay, or public-STUN offer/answer over an
arbitrary side channel. These are available in anonymous/free mode without an
entitlement check. Only the paid managed deployment is unavailable with the
engine; failed direct and configured relay attempts end in `No route`.

## Connectivity-service trust boundary

A self-hosted/community or managed rendezvous/relay operator is an untrusted
network facilitator, not an account peer. Source IP, timing, allocation IDs, and
byte volume remain visible to the operator. It can censor, rate-limit, or
inflate cost. Public STUN sees caller IP and timing; a side-channel provider
sees the encrypted offer and participants.

The operator cannot derive a stable account ID from rotating opaque topics
alone, decrypt endpoint descriptors or application/credential frames, forge a
runner key/grant, approve pairing, authorize an operation, vote on replica
safety, or read/store-and-forward account data. Those claims depend on topic
secrets, endpoint authentication, and grants, not TLS to the service. A
malicious service can still correlate repeated network metadata. Anyone who
obtains a returning-peer discovery secret can monitor its topics; rotate it
after device removal or suspected leakage. A one-use admission secret creates a
route only and is erased after completion/cancellation; it is not derived into
account keys or grants.

Require short TTLs, minimal logs, encrypted descriptors, topic/key rotation,
padding/bounded sizes where practical, replay and registration proofs, quotas,
and multi-service/manual fallback. Relay allocations are live and bounded; no
offline inbox exists. TLS protects clients from passive observers but does not
make an operator trusted. UI names the operator and route. Self-hosting changes
who sees metadata, not what authority the service has. If candidates do not
produce an authenticated direct route and no approved relay works, return
`No route`; neither the engine application socket nor backup subscription is a
hidden fallback.

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
| Engine becomes broker                | Route telemetry, no ordinary fan-out endpoint, healthy/blocked engine tests; any relay is opaque and labeled.                                                           |
| Rendezvous/relay operator abuse      | Rotating opaque topics, encrypted signed descriptors, endpoint grant checks, bounded live allocations, multi-source fallback; operator metadata exposure is disclosed.  |
| Discovery-topic or offer theft       | High-entropy domain-separated returning/one-use secrets, expiry/transcript binding, no auto-admission, rotation/erasure after leak/use; candidates grant no authority.  |
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
| Discovery leak/poisoning             | No account ID/content; rotating opaque topic, encrypted signed descriptors, short TTL, replay/rate limits, endpoint handshake; DHT off by default.                      |

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
