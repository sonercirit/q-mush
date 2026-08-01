# Peer credential distribution

This document is normative detail for the
[local-first architecture](../local-first-architecture.md). Device trust is
specified in [trust-and-security.md](trust-and-security.md).

## Credential-plane boundary

Secrets use a runner-only credential plane separate from ordinary replication.
The operation log contains only non-secret credential state:

- random credential ID, provider kind, display label, and version;
- non-sensitive provider capabilities where appropriate;
- policy naming authorized executor runner IDs (default: every trusted executor
  runner), expiry, and revocation state; and
- signed target delivery receipts containing no ciphertext or endpoint/key.

Generic base URLs can contain private hostnames, paths, or tenant data and
therefore travel with the secret payload, not discovery or ordinary metadata.
Plaintext credentials and sealed envelopes are never operations, snapshots,
application blobs, browser-readable fields, or engine backup data.

Each runner has an X25519 envelope key certified in its device grant and a
private vault protected by OS keychain/secure hardware or a local wrapping key.
For every credential version and target, the source creates a fresh random
content key and authenticated ciphertext, then seals that key independently to
the target's current X25519 key. Associated data binds:

```text
account ID + credential ID + version + provider kind + target device ID
+ target key ID + policy operation hash + issued/expiry times + payload hash
```

The signed envelope frame also binds source device, one-time delivery ID, and
protocol version. Re-encryption always decrypts inside an authorized runner
vault and creates a new target envelope; a target-bound envelope is never
forwarded unchanged. Delivery is idempotent by
`(credentialId, version, targetDeviceId)`. After durable vault write, the target
emits a signed non-secret receipt into ordinary replication.

Offline targets catch up when they directly reach any currently authorized
runner holding that credential. Revocation stops new use and resealing, removes
local wrapped content keys, and gossips metadata. As with all offline
revocation, a partitioned target may use its last valid envelope until bounded
expiry.

The credential channel is runner-to-runner, mutually authenticated,
forward-secret, replay protected, size bounded, and rate limited. Browser peers
may initiate policy intent by credential ID but never carry payload frames. An
end-to-end encrypted fallback relay may tunnel a live frame as opaque bytes; it
cannot store an envelope in the application log or address it as a blob. Crash
dumps, metrics, traces, diagnostics, and audit logs record only IDs, version,
target, size, result code, and timestamps.

A credential policy may target fewer than all executor runners for
least-privilege reasons, but that is a conscious secret-availability setting,
not partial ordinary replication. The UI warns that excluded targets cannot run
that provider and do not provide credential failover. It never implies that a
full data replica includes the secret.

## User-entered credentials: no engine traffic

API keys, generic LLM endpoint configuration/keys, Brave Search keys, and any
future secret with no genuine third-party connect flow are created as follows:

1. The user opens the app served by a trusted runner. A secret-entry form posts
   over the same-origin authenticated TLS/loopback request directly into that
   runner vault. JavaScript holds the form value only for submission and clears
   it; no browser persistence, application state store, analytics, or service
   worker sees it.
2. The runner creates the replicated non-secret policy/version operation and a
   local vault record atomically enough to expose no usable summary without a
   corresponding source vault version.
3. It enumerates authorized runner device keys from the peer-replicated trust
   registry, creates an independent envelope for each target, and sends them
   over direct credential channels. **No engine endpoint is contacted for
   create, rotate, revoke, distribution, retry, or acknowledgement.**
4. Targets commit to private vaults, zero transient plaintext/key buffers where
   runtime permits, and publish non-secret receipts. The UI reports target
   availability without exposing secret values.

A remote browser that cannot safely post to a runner never receives a plaintext
fallback. The UI asks the user to open a runner-served origin or establish a
secure direct runner form channel. Credential export is a separate explicit,
locally encrypted recovery workflow, not browser copy-through.

Secret rotation publishes a new metadata version only after its source vault
commit. Each target receives a new independently sealed payload. Once policy
marks the old version superseded/revoked and bounded offline use expires,
targets cryptographically erase its wrapped key. Deleting the only source before
another target receipt requires a destructive warning because ordinary full
replication cannot recover secret bytes.

## Genuine third-party OAuth handshakes

Only a flow that inherently needs a public registered callback or confidential
exchange may involve the engine: Google login/account recovery and OpenAI or
OpenRouter OAuth. Even then the engine's role ends at handshake completion:

1. The initiating runner generates a one-time request ID, X25519 return key,
   PKCE verifier/challenge where supported, expected provider/account, expiry,
   and signed callback binding. It sends only this handshake request to the
   engine and opens the authorization URL.
2. The engine validates user/account intent, performs the registered callback
   and code exchange, and immediately encrypts resulting access/refresh material
   to the one-time runner return key with associated request/provider/account
   data.
3. The engine sends the sealed result to the initiating runner, erases
   plaintext/code/verifier and any transient encrypted result after acknowledged
   delivery or short timeout, and never inserts provider tokens into its
   database, logs, optional backup replica, or environment-key credential store.
4. The runner opens the result into its vault, publishes non-secret metadata,
   and distributes per-device envelopes to authorized runners over the peer
   credential plane. No per-target engine request occurs.
5. Refresh happens runner-side whenever provider semantics permit. A designated
   credential leader serializes rotation, emits a new metadata version, and
   peer-distributes it. If a provider requires the registered engine client for
   refresh, the same narrowly scoped sealed handshake is used only for refresh;
   ordinary use and fan-out remain peer-side.

OAuth state is single-use, short-lived, account/request bound, and protected
against callback mix-up and replay. The engine cannot substitute another target
key undetectably because the initiating runner's signed request and return key
are bound through authorization state and sealed response. Delivery failure
retains no long-lived engine token: the user restarts the handshake.

This changes current custody deliberately. Provider OAuth material must no
longer remain in `provider_credentials.encrypted_credential` for routine engine
use. Migration performs an authenticated sealed handoff to at least one runner,
verifies its vault receipt, peer-distributes to policy targets, then clears the
legacy engine ciphertext under the existing soft-delete/audit policy. Until that
succeeds, the credential is visibly `legacy engine-held` and not claimed as
engine-independent.

## Secret exclusion and validation

Plaintext and envelope ciphertext never enter:

- IndexedDB, `localStorage`, service-worker cache, or browser application state
  beyond the transient input field/request body;
- ordinary operations, snapshots, application blobs, SQLite projections, or
  optional engine backup state;
- mDNS, candidate/peer lists, tab WebRTC/BroadcastChannel messages;
- runner tool commands, prompts, transcripts, diagnostics, bundles, analytics,
  or logs; or
- engine processes at all, except transient plaintext during a genuine OAuth
  exchange and its immediate sealed return.

Ordinary peer captures may contain credential IDs, policy, and delivery
receipts, never payload bytes. Credential-plane captures contain only
independently target-sealed frames. Browser and ordinary-sync codecs reject
credential payload frame types rather than merely promising not to produce them.
Vault files use a distinct path/key/schema and are excluded from replica
snapshot/export code by construction.

Required tests use canary secrets and process/network interception to prove:

- firewalling every engine endpoint still permits create, rotation,
  distribution, revocation, and target acknowledgement for API, generic, and
  Brave credentials;
- engine request logs remain empty during those flows;
- each target envelope differs, cannot open on another runner, and fails after
  associated-data or policy modification;
- replay, rollback, wrong target key, revoked policy, expired grant, and payload
  mismatch fail closed;
- a genuine OAuth exchange leaves no durable engine token and subsequent fan-out
  generates only runner-to-runner traffic; and
- browser memory/storage capture (apart from the unavoidable live input control
  and request), ordinary replication, logs, crashes, updates, exports, and tool
  invocations contain no canary.

## Credential-specific threats

| Threat                                         | Required mitigation/test                                                                                                                                                                            |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One runner compromise steals its credentials   | Per-device envelopes, vault key separate from replica DB, OS keychain/secure hardware, target/policy/expiry binding, optional narrower policy, rapid revoke/rotate; no account-wide decryption key. |
| Malicious source substitutes payload or target | Signed policy hash/source, certified target key, associated-data binding, one-time delivery, visible target receipt, monotonic version, OAuth callback-key binding.                                 |
| Envelope replay or rollback                    | Version, target/key ID, expiry, revocation metadata, durable delivery ledger, nonce; reject lower version and duplicate delivery with another hash.                                                 |
| Payload leaks into ordinary replication        | Separate endpoints/codecs/stores/keys, type-level separation, browser rejection, canary inspection of operations, snapshots, blobs, relays, logs, crashes, bundles, and commands.                   |
| Compromised/curious engine reads secrets       | User-entered secrets never contact it; OAuth plaintext immediately target-sealed, no token row, strict redaction/retention, capture tests, and process-isolation review.                            |
| Source disappears before distribution          | Default all-executor policy, explicit per-target receipts, destructive warning before last-copy erase, optional encrypted user-held recovery export.                                                |
| Offline revoked target keeps using a key       | Short envelope/grant expiry, prioritized revocation gossip, provider-side rotation/revocation, visible stale window; instantaneous partition revocation is not claimed.                             |
