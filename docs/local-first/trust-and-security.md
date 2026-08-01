# Trust, degraded operation, and security

This document is normative detail for the
[local-first architecture](../local-first-architecture.md). Topology and app
delivery are specified in [runtime-and-transport.md](runtime-and-transport.md);
exact secret custody and flows are specified in
[credentials.md](credentials.md).

## Authentication and peer-side trust

### Account trust root and device grants

Google remains an account bootstrap/recovery identity, not a steady-state login
or offline authentication dependency. Initial enrollment creates:

- Ed25519 signing and X25519 encryption keys on the first owner device;
- a random device ID distinct from machine fingerprint;
- an engine-signed bootstrap assertion binding the Google account ID to the
  owner's public signing key; and
- a signed account genesis operation naming that owner key and recovery policy.

The engine assertion can establish or recover the first owner but cannot sign
ordinary application data, execution epochs, runner grants, or credentials.
Private owner keys never leave the device. Runner private keys stay mode `0600`
in the private runner home, protected by OS keychain/secure hardware where
available and a sealed private-file fallback. Browser profiles use
non-extractable WebCrypto keys in IndexedDB where supported. A profile, not each
tab, is the durable browser device.

Thereafter trust administration is peer-side. An already trusted owner device
can directly:

- approve a runner or browser key after fingerprint/user confirmation;
- issue grants no wider than its own capabilities;
- renew another device within owner policy;
- add another owner with explicit high-risk confirmation; and
- sign a remove-wins revocation and gossip it to reachable peers.

None requires an engine request. Engine-assisted Google recovery may replace a
lost owner only under recorded recovery policy and must produce an auditable
trust-root transition; it cannot silently undo an owner revocation.

A runner membership grant commits it to storing the full account replica.
Workspace capabilities constrain browser views, execution, directory access, and
credential use, but do not permit an enrolled runner to omit durable account
records. Every runner is therefore a high-trust account device. Multi-user
installations keep cryptographically/logically separate account replicas.

Certificates/grants cover realistic outages but expire. An offline peer accepts
only an unexpired chain not rejected by its newest revocation frontier and
cannot self-renew. Persist highest trusted time/HLC so clock rollback fails new
writes closed while cached reads remain. Revocation cannot instantly reach a
partition: authorization may remain stale until grant expiry or newer gossip.
The UI shows exact expiry and revocation-frontier age.

### Pairing without an engine

Serving assets is public; data remains locked. First access supports:

1. **Owner-device pairing (normal):** the joining peer presents ephemeral keys
   and a one-time challenge. An owner is reached directly or through an
   authenticated runner, both sides display fingerprints, the user approves, and
   the owner signs the bounded grant.
2. **Local physical pairing:** runner CLI/UI and owner use a transcript-bound
   PAKE-style QR/code exchange and require confirmation. A non-owner runner may
   introduce candidates but cannot mint a grant.
3. **Engine identity bootstrap/recovery:** after Google login the engine signs
   only a short-lived bootstrap/recovery assertion. The owner then records trust
   operations directly with peers.
4. **Returning profile:** device-key challenge-response followed by a
   short-lived, origin-bound HttpOnly runner cookie and WebSocket proof.

Codes expire in minutes, are single-use/rate-limited, and bind the live
transcript. Never place durable bearer tokens in URLs, QR payloads,
`localStorage`, bundles, or logs. State-changing HTTP requires exact `Origin`,
CSRF, and device authorization; WebSockets require exact origin and signed
nonce.

The current `qmr_…` token in `runner/runner-agent.ts`, hashed by
`sync-engine/runner-token.ts`, authenticates only the legacy runner/engine
socket. It is neither browser password nor mesh key and is retired after device
credential migration.

### Peer authentication and revocation

All peer links mutually sign nonce handshakes and validate account trust chain,
grant capabilities, purpose-specific keys, protocol, and revocation frontier
before revealing data. A browser receives only its grant intersection. A runner
authenticates full-replica membership but still needs capabilities for execution
or vault use.

Owner trust operations replicate peer-first. Peers prioritize missing
revocations over application data at handshake. The optional engine may
retain/gossip them as one peer but is neither required signer nor freshness
source. Sensitive owner or credential-policy changes require a configured
maximum revocation age; without a sufficiently fresh owner peer they fail closed
rather than defaulting through the engine.

Keys are purpose-separated: identity bootstrap/recovery, owner delegation,
device operation signing, envelope encryption, execution epoch, and release
publication. An engine release or OAuth-handshake signature grants no device or
transcript authority.

## Degraded-mode contract

A hosted LLM still needs its provider network; engine independence does not mean
internet independence. A fresh browser cannot load code from an unreachable
host.

| Action                                     | Engine down, any ready runner reachable                        | Cached browser, no runner     | Contract                                                                    |
| ------------------------------------------ | -------------------------------------------------------------- | ----------------------------- | --------------------------------------------------------------------------- |
| Open app                                   | Yes, embedded release                                          | Previously installed only     | A runner is the normal app host.                                            |
| Read all shared data/attachments           | Yes, full account replica                                      | Cached projection/blobs only  | Runner scope is never “its sessions.”                                       |
| Edit prompts/workspace/session metadata    | Yes, direct operation                                          | Supported edits queue locally | Show `local-only` until another runner receipt.                             |
| Create/continue/steer/answer/stop/compact  | With authority, grant, vault, and provider                     | Queue request only            | Executor receipt controls status.                                           |
| Browse directories/run tools               | On selected reachable runner                                   | No                            | External filesystem stays local.                                            |
| Spawn or graceful handoff                  | Directly between compatible authorized runners                 | No                            | Unreachable authority offers recovery fork.                                 |
| Pair/renew/revoke a device                 | With a reachable authorized owner device                       | If that profile is owner      | Signed peer trust operations; bounded stale revocation.                     |
| Add/rotate/revoke API/generic/Brave secret | Enter on a runner; distribute runner-to-runner                 | No                            | Zero engine requests.                                                       |
| Redistribute existing OAuth material       | From an authorized credential-holding runner                   | No                            | Fresh per-target envelopes.                                                 |
| Start/renew OpenAI/OpenRouter OAuth        | Not if its registered engine handshake endpoint is unavailable | No                            | Existing valid tokens continue.                                             |
| Google login/trust-root recovery           | No                                                             | No                            | Existing grants continue until expiry.                                      |
| Discover peers                             | Cached/manual/LAN/reachable runner rendezvous                  | Cached/manual/WebRTC          | Optional engine-only candidates may be unavailable; no hidden broker route. |
| Replicate ordinary state                   | Direct peer links                                              | To reachable peers only       | Explicit opaque relay may be unavailable if engine-operated.                |
| Download update                            | From a signed peer/mirror; otherwise continue existing release | Existing release              | Engine release hosting is optional distribution.                            |
| Hosted model/Brave call                    | If provider, authority, and local vault work                   | No executor                   | Report provider failure separately.                                         |

Engine-down therefore loses almost nothing in steady state. Unavailable
functions are new Google bootstrap/recovery, genuine OAuth handshakes tied to
the engine, engine-only rendezvous/relay reachability, an update held by no peer
or mirror, and the optional engine backup itself. Ordinary sync, all-runner data
access, local execution, peer trust administration, and user-entered credential
provisioning continue.

## Security analysis

A runner changes from outbound-only worker into app server, full account
replica, coordinator, trust participant, and credential holder. It is a
high-value device; full replication deliberately trades availability for a
larger compromise blast radius.

| Threat                                       | Required mitigation/test                                                                                                                                                                                                                |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One runner host is compromised               | Treat as full account-data disclosure and writes within unexpired grant; encrypted disk/vault, OS keychain/hardware, least privilege, auto-lock, patching, remote revoke, short grants, audit/equivocation alert. Root is out of scope. |
| Compromised runner steals credentials        | Independent device envelopes, vault key separate from replica DB, target/policy/expiry binding, optional hardware keys/narrow policy, rapid revoke/rotate; never one account decryption key.                                            |
| Credential channel/envelope attack           | Separate channel/store/key, target-key and policy-hash binding, forward secrecy, replay/version checks, browser rejection, canary capture tests; see [credentials.md](credentials.md).                                                  |
| Compromised or curious engine reads secrets  | User-entered secrets never contact it; OAuth plaintext is transient/immediately target-sealed, no token DB row, strict redaction/retention and process/network capture tests.                                                           |
| Engine becomes an implicit data broker       | Enforced route order, endpoint/path telemetry, tests blocking engine data APIs while healthy, no ordinary store-forward endpoint; relay is opaque/end-to-end and explicitly labeled.                                                    |
| DNS rebinding/hostile site attacks local API | Authenticate every endpoint; exact allowlisted `Host`/`Origin`; reject `null`; no wildcard CORS; CSRF; WebSocket nonce proof; secret form same-origin/non-reflective.                                                                   |
| LAN interception/MITM                        | Pinned TLS and challenge-response; never trust RFC1918/`.local`; display fingerprints.                                                                                                                                                  |
| Pairing theft/malicious delegated grant      | Transcript-bound PAKE, short single-use code, owner confirmation, delegation cannot widen issuer, owner-add ceremony, signed audit, rate limiting.                                                                                      |
| Browser XSS steals capability/entered secret | Strict self/hash CSP, unsafe-HTML lint, HttpOnly/SameSite cookie, non-extractable keys, no secret persistence, isolated form/autocomplete policy, short lifetime, escaped output.                                                       |
| Peer forges or poisons full replica          | Canonical signatures, grant/epoch checks, monotonic sequence, causal/schema/size validation, quarantine/equivocation alert, snapshot/blob Merkle/hash checks.                                                                           |
| Split-brain model/tool effects               | No timeout takeover; signed handoff/epoch fencing; stale rejection; recovery fork; persist tool start before execution.                                                                                                                 |
| Disk/network exhaustion                      | Capacity reserve, channel limits, bounded resumable chunks, decompression/signature budgets, dedupe, growth UI, reject oversized import before operation commit, safe retirement.                                                       |
| False completeness receipt                   | Signed frontier/blob-root challenge, local verification, no `ready`/execution/redundancy role until complete; never delete based on an unverified receipt.                                                                              |
| Offline revoked device                       | Bounded expiry, priority revocation gossip, freshness for sensitive changes, visible stale window, rotate affected secrets.                                                                                                             |
| Update injection                             | Installer-rooted publisher signature, SHA-256, immutable assets, atomic rollback; peer supplies bytes but no authorship.                                                                                                                |
| Discovery metadata leak                      | Opaque ID/candidates/version only; authenticate before frontier; no endpoint/provider labels.                                                                                                                                           |

Full-replica data at rest uses platform full-disk encryption at minimum; where
practical an application database/blob key is sealed to OS keychain/secure
hardware. This protects a powered-off stolen disk, not root/admin on a running
host. Vault keys remain separate so a copied replica file reveals no
credentials. Backups/exports are encrypted and exclude vault data unless the
user explicitly creates a separate credential recovery export.

Security logs contain IDs, kinds, sizes, routes, and rejection codes—not prompt
content, paths, tokens, generic endpoints, or envelope bytes.
`Forget/retire runner` revokes membership, moves any unique local data to
another ready runner when possible, and cryptographically erases local
replica/vault keys. It cannot erase exfiltrated copies. Shared application
deletion continues through audited soft-delete operations and safe retention.

GitHub Security Lab's
[localhost/CORS/DNS-rebinding analysis](https://github.blog/security/application-security/localhost-dangers-cors-and-dns-rebinding/)
recommends authentication and approved `Host` checks. Loopback binding is not a
security boundary.
