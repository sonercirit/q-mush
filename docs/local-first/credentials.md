# Peer credential distribution

This document is normative detail for the
[local-first architecture](../local-first-architecture.md). Device trust and
account recovery are specified in
[trust-and-security.md](trust-and-security.md).

## Credential-plane boundary

Secrets use a runner-only credential plane separate from ordinary replication.
The operation log and readable engine backup may contain only non-secret state:

- random credential ID, provider kind, display label, source, fingerprint, and
  version;
- non-sensitive provider capabilities/default/connectivity state;
- policy naming authorized executor runners, expiry, and revocation; and
- signed target delivery receipts without ciphertext, endpoint, or key.

Generic base URLs can expose private hosts, paths, or tenant data and travel in
the vault payload, not ordinary metadata. Plaintext credentials and sealed
envelopes are never operations, snapshots, application blobs, browser-readable
fields, or engine backup data. The current
`provider_credentials.encrypted_credential` and potentially sensitive `base_url`
therefore have no direct replicated projection; the precise sanitized schema
mapping is in
[replication.md](replication.md#engine-backup-partition-by-schema-entity).

Each runner has an X25519 envelope key certified by its device grant and a
private vault protected by OS keychain/secure hardware or a wrapping key. For
each credential version/target, a source creates fresh authenticated ciphertext
and independently seals its content key to the target's current key. Associated
data binds:

```text
account ID + credential ID + version + provider kind + target device ID
+ target key ID + policy operation hash + issued/expiry times + payload hash
```

The signed frame also binds source, one-time delivery ID, and protocol version.
Re-encryption decrypts only inside an authorized runner and creates a fresh
target envelope; an envelope is never forwarded unchanged. Delivery is
idempotent by `(credentialId, version, targetDeviceId)`. After durable vault
write, the target emits a non-secret receipt through ordinary replication.

Offline targets catch up directly from any authorized credential holder.
Revocation stops use/resealing, removes wrapped content keys, and gossips
metadata. A partitioned target may use its last valid envelope until bounded
expiry. Credential channels are runner-to-runner, mutually authenticated,
forward-secret, replay-protected, bounded, and rate-limited. Browsers may submit
policy intent by ID but never carry payload frames. An endpoint-encrypted relay
may tunnel a live frame as opaque bytes but cannot store it.

A user may narrow the default all-executor target policy, but UI warns that
excluded runners cannot execute with or fail over that credential. A full data
replica does not imply a secret copy. Discovery and signaling remain outside the
credential plane: a rendezvous topic, candidate, STUN response, or manual ICE
package cannot request an envelope. Only an endpoint-authenticated runner that
proves its target key and valid credential policy may open this channel, whether
the bytes travel directly or through a named opaque relay.

## User-entered credentials: no engine traffic

API keys, generic LLM endpoint configuration/keys, Brave Search keys, and future
non-connect secrets follow this flow:

1. At a trusted runner origin, a transient form posts directly into that
   runner's vault. JavaScript clears the input; no browser persistence,
   analytics, service worker, or shared state receives it.
2. The runner commits a non-secret policy/version operation and local vault
   record without exposing a usable summary before source custody exists.
3. It reads authorized runner keys from the peer-replicated registry, makes an
   independent target envelope, and sends each over direct credential channels.
   **Create, rotate, revoke, retry, distribution, and acknowledgement issue zero
   engine requests.**
4. Targets commit privately and publish non-secret receipts. UI displays
   availability without values.

A remote browser without a secure runner form path never receives a plaintext
fallback; it asks the user to open a runner origin or establish a direct secure
form channel. Export is a separate explicit locally encrypted recovery workflow.

Rotation creates new target envelopes and versions. After bounded old-version
expiry, targets erase wrapped keys. Deleting the last holder before another
receipt requires a destructive warning because ordinary/engine replicas cannot
recover secret bytes.

## Provider authorization flows

Provider authorization is not a reason to send tokens through the engine. The
current repository behavior was verified from `sync-engine/openai.ts`,
`sync-engine/index.ts`, `sync-engine/openrouter.ts`, and shared routes:

- OpenAI currently starts an authorization-code/PKCE flow in the engine and, for
  the default public client, starts a second Bun listener on
  `http://localhost:1455/auth/callback`. That callback belongs to the machine
  running the production engine, not necessarily the user's runner/browser, so
  it is not a viable production connect flow.
- OpenRouter currently sends a `callback_url` supplied by Q Mush, uses PKCE, and
  exchanges the returned code at `/api/v1/auth/keys`. It has no configured
  client ID or client secret in this repository. Its callback is URL-bound for
  the transaction but not engine-bound: an initiating runner can host the exact
  callback and perform the exchange.

Consequently **Google identity is the target engine's only OAuth/OIDC flow**.
Neither OpenAI nor OpenRouter provider material enters an engine process.

### OpenAI device-code flow

OpenAI authorization is replaced—not supplemented—with a runner-side device
flow:

1. The runner requests a device/user code from the provider over outbound HTTPS.
2. The Solid view displays the exact provider verification URL, short user code,
   expiry, and cancellation state. The browser opens that provider URL but never
   receives resulting tokens.
3. The user enters/confirms the code at the provider. The runner polls the
   provider token endpoint at the specified interval, handles pending/slow-down,
   expiry, denial, and cancellation, and validates returned account metadata.
4. The runner commits access/refresh material directly to its vault, publishes
   sanitized metadata, and distributes fresh target envelopes peer-to-peer.
5. A designated credential holder refreshes outbound from a runner, versions the
   result, and redistributes it. No inbound listener, port `1455`, engine
   callback, engine cookie, or engine credential key is involved.

Implementation must verify the provider's production device-authorization
contract, endpoints, client eligibility, polling rules, and scopes before
shipping. If the provider does not expose a usable device-code contract, Q Mush
must fail honestly or support API keys; it must not retain the old engine
loopback flow as a hidden fallback.

### OpenRouter runner-local PKCE

OpenRouter connect starts at a trusted runner. That runner creates state/PKCE,
uses its stable callback URL in OpenRouter's `callback_url`, validates callback
state/origin/account intent, exchanges the code outbound, stores the returned
user-controlled key in its vault, and peer-distributes it. Exact Host/Origin,
short single-use state, callback path, expiry, replay, and mix-up checks apply.
A runner without a provider-reachable callback may use an API key instead; it
does not bounce through the engine. This conclusion must be revisited if
OpenRouter later requires a confidential/registered engine client.

## What the migration deletes

After runner provider flows and vault migration are proven, remove the engine's
provider connect/custody surface rather than leaving two paths:

- the OpenAI loopback constants/listener and startup/shutdown handling in
  `sync-engine/index.ts`/`sync-engine/openai.ts`, including port `1455`;
- engine OpenAI authorization, callback, code exchange, refresh, and provider
  credential routes (`/api/openai/oauth`, `/api/openai/oauth/callback`, and
  engine credential mutation/custody);
- `OPENAI_CLIENT_ID`, `OPENAI_REDIRECT_URI`, and `OPENAI_CREDENTIAL_KEY`
  requirements for provider custody;
- engine OpenRouter authorization/callback/key exchange and provider credential
  routes (`/api/openrouter/oauth`, `/api/openrouter/oauth/callback`, and engine
  credential mutation/custody), plus `OPENROUTER_REDIRECT_URI` and
  `OPENROUTER_CREDENTIAL_KEY` custody;
- shared/engine connected-account cookie/configuration code only after Google
  auth no longer imports the pieces it still needs; and
- provider-token ciphertext in legacy `provider_credentials` rows after verified
  migration, under soft-delete/audit retention without retaining the secret.

Do **not** delete Google `/api/auth/google/callback`, generic OAuth/PKCE helpers
still used by Google, runner-side OpenAI token parsing/refresh/model support, or
runner-side OpenRouter exchange/use merely because their current versions live
under `sync-engine/`. Runtime-neutral/provider logic moves to `shared/` with
runner adapters. Shared route constants and Solid links for removed engine
provider callbacks are replaced by runner-local APIs, not retained aliases.

## Legacy credential migration

Current provider secrets are engine-encrypted. User-entered API/generic/Brave
values may make a one-time authenticated target-sealed transfer to an owner
runner if implementing that migration does not expose plaintext outside the
legacy process. The runner verifies vault and peer receipts, then the engine
clears ciphertext.

For OpenAI OAuth, device-code **re-authorization is the default migration**:
show `Re-authenticate on a runner`, retain only sanitized identity/label long
enough to match the new credential, and delete old engine tokens after success
or a clearly announced migration deadline. Do not build new long-lived engine
token handoff around the obsolete callback flow. OpenRouter may likewise
reauthorize runner-side; a narrowly bounded one-time sealed handoff is
acceptable only as a migration mechanism and never steady-state custody.

Until complete, a credential is visibly `legacy engine-held`; it is not claimed
as engine-independent or recoverable from readable backup. Tier does not alter
secret migration or custody.

## Secret exclusion and validation

Plaintext and envelope ciphertext never enter:

- IndexedDB, `localStorage`, service-worker cache, browser stores, or browser
  messages beyond the transient secret input/request;
- ordinary operations, snapshots, blobs, SQLite projections, or free/paid engine
  backup;
- discovery descriptors/topics, candidate lists, STUN/TURN control data, manual
  offer/answer packages, `BroadcastChannel`, or browser WebRTC;
- tools, prompts, transcripts, diagnostics, bundles, analytics, logs, or crash
  output; or
- engine processes after migration. Google identity tokens are separately
  discarded under the auth design and are not provider credentials.

Ordinary captures may show only IDs/policy/receipts. Credential captures contain
independent target ciphertext. Browser and engine codecs reject credential frame
types. Vault paths/keys/schemas are separate from snapshot/export code.

Required tests prove:

- blocking every engine endpoint still permits API/generic/Brave lifecycle,
  OpenAI device authorization, OpenRouter runner callback, refresh, and
  peer-distribution;
- no request from those flows reaches the engine and no provider token row is
  created there;
- target envelopes differ and fail on wrong target/policy/version/replay;
- browser/ordinary/backup/log/crash/update/export/tool captures contain no
  canary; and
- deleting legacy provider routes/listener does not remove Google login or
  runner-side provider model/quota behavior.

## Credential-specific threats

| Threat                                       | Required mitigation/test                                                                                                                           |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| One runner compromise steals its credentials | Per-device vault/envelopes, separate keys, OS protection, target/policy/expiry binding, revoke/rotate; no account-wide key.                        |
| Source substitutes payload/target            | Signed policy/source, certified target key, associated data, one-time delivery, visible receipt, monotonic version.                                |
| Replay or rollback                           | Version, target/key ID, expiry, revocation, durable ledger, nonce; reject lower version or changed duplicate.                                      |
| Secret leaks to ordinary/engine storage      | Separate codecs/stores/routes/keys, type-level exclusion, canary inspection across snapshots, backup, browser, logs, crashes, exports, and tools.  |
| Engine provider path survives migration      | Route/startup capture tests and removal assertions; only Google identity OAuth remains.                                                            |
| Device authorization phishing                | Show exact provider-owned URL/domain and code/expiry; never ask for provider password; bind polled response to request/account and cancel visibly. |
| Callback attack on runner OpenRouter flow    | Pinned callback origin/path, PKCE, state, short expiry, single use, account-intent binding, exact Host/Origin, no open redirect.                   |
| Source disappears before distribution        | Default all-executor policy, per-target receipts, last-copy warning, optional user-held encrypted recovery.                                        |
| Offline revoked target keeps using key       | Short grant/envelope expiry, priority gossip, provider rotation/revocation, visible stale window; no instant-partition claim.                      |
