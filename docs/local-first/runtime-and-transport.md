# Runtime and transport

This document is normative detail for the
[local-first architecture](../local-first-architecture.md). Authentication,
credential handling, and degraded behavior are specified in
[trust-and-security.md](trust-and-security.md).

## Peer-first topology

Every runner starts a loopback app/API/peer listener by default and may
explicitly enable a paired LAN or remote listener. Its port and stable local
origin are persisted so IndexedDB, service-worker state, and cookies survive
restarts. Discovery exposes only opaque peer ID, connection candidates, and
protocol versions; private metadata appears only after mutual authentication.

The route policy is invariant, not an optimization:

1. Use a same-host runner WebSocket or `BroadcastChannel` route where available.
2. Prefer direct authenticated runner WebSocket/TLS, LAN, user VPN/overlay, or
   established WebRTC between remote peers.
3. Use cached/manual rendezvous candidates to establish another direct route.
4. Only after direct establishment fails may the user/policy select an
   end-to-end encrypted relay/TURN tunnel. The UI labels it `Relay fallback`.
5. If no direct route or approved fallback exists, report `No route`; do not
   silently broker through the engine's application WebSocket.

Engine health does not change this ordering. Engine rendezvous can exchange
signed, opaque candidates or WebRTC signaling, but after establishment all
ordinary operations, blobs, commands, receipts, and live streams traverse the
peer connection. An engine-operated relay is allowed only under step 4 and has
no endpoint keys or workspace grants. The engine must never terminate A's data
frames and re-emit them to B as an ordinary peer sync flow.

An optional engine backup is a normal subscriber: runner A can sync A's frontier
to it and runner B can independently sync B's frontier to it. Those
subscriptions must not replace or proxy the A-to-B connection. Path tests and
diagnostics identify every frame's endpoint pair and assert that ordinary
runner/browser traffic has no hidden engine hop.

### Same host and tabs

A tab opened from `http://127.0.0.1:`\<port>`/app` (or a stable loopback
hostname) uses a same-origin WebSocket to that runner. This is the core outage
path: the runner serves app and API, supplies a full account projection, accepts
commands for its executor, and introduces other peers. An engine-served app may
connect outward to a paired runner, but the design never depends on a public web
origin reaching loopback through browser Local Network Access exceptions.

Same-origin tabs use `BroadcastChannel` to elect one transport owner per browser
profile/origin and fan out operation notifications. Each tab remains a logical
peer, but one connection avoids redundant anti-entropy. Tabs on engine and
runner origins use authenticated peer transport rather than `BroadcastChannel`.

### LAN

An explicitly LAN-enabled runner binds a private interface and advertises a
DNS-SD service such as `_qmush._tcp` with protocol/app version, port, and opaque
peer-key fingerprint. The runner process browses mDNS; ordinary pages cannot be
assumed to have multicast APIs. A user opens the advertised `.local` URL or
enters/scans an address and pairs.

Private addressing is not trust. Write-capable LAN mode requires a stable HTTPS
origin with a pinned runner certificate, or loopback termination through a
native helper. Stage 1 is loopback-only. Until certificate onboarding is usable,
opt-in plain HTTP LAN access is read-only and visibly warned, or disabled.

### Remote networks and NAT

A runner accepts a pinned manual HTTPS URL, including a user VPN, reverse
tunnel, or overlay. WebRTC ICE may require STUN/TURN across firewalls and NAT,
and a browser cannot accept arbitrary inbound TCP. Candidate sources are, in
order, reachable runners, local cache, manual QR/copy-paste, and optional engine
rendezvous. Candidate exchange grants no data authority.

If the only signaling or relay service fails before candidates are exchanged, a
new remote route may be impossible. Remote outage operation therefore needs at
least one of:

- an open/recoverable WebRTC connection with cached ICE information;
- a pinned directly reachable HTTPS runner URL;
- shared LAN or user VPN/overlay;
- manual one-time offer/answer exchange; or
- a separately reachable end-to-end encrypted fallback relay.

Manual offer/answer is a supported engine-free bootstrap, not merely a debug
path. P2P cannot defeat every NAT; honest `No route` is preferable to turning
the engine into an implicit broker.

### Browser-to-browser

Tabs have no listener, so they connect outward:

- same origin: `BroadcastChannel`;
- different origins/devices: WebRTC `RTCDataChannel`, signaled by a runner,
  manual exchange, or optional engine rendezvous; and
- no direct WebRTC route: an explicitly approved encrypted fallback relay.

A tab may carry authorized ordinary operations but cannot execute a session,
qualify as a full runner redundancy copy, or receive credential envelopes.
WebRTC transport encryption does not replace Q Mush peer authentication.
Credential envelopes are runner-to-runner only even when a browser helps with
signaling.

## App distribution and versioning

### Build artifact

Every installed runner contains an immutable web release:

```text
manifest.json
app shell
app.\<content hash\>.js
styles.\<content hash\>.css
favicon/icons
optional service worker
protocol/schema compatibility range
SHA-256 for every file
release signature
```

The runner serves it without Vite or sources. Hashed assets use immutable
caching; manifest and shell use ETag revalidation. A later service worker may
precache one verified release and retain the prior compatible release for
rollback; it never caches API responses or credential-plane traffic.

`sync-engine/client-build.ts` already points Vite at `solid/client.tsx`, and
`sync-engine/server.ts` reads its output. Refactor this into one build-time
artifact producer for engine migration hosting and runner packaging rather than
creating another Solid build configuration.

### Existing update chain

`sync-engine/runner-executable.ts` fingerprints runner source plus Bun version,
cross-compiles privately, caches by target, and serves ETag/SHA-256.
`runner/runner-update.ts` bounds/verifies download, atomically replaces the
executable, and restarts after drain. Extend the chain:

1. Produce web manifest/assets once from the Vite build.
2. Include their digest and compatibility range in the runner fingerprint and
   embed the release in the executable by default.
3. Verify executable/manifest, drain execution, atomically replace, and restart.
4. Keep release `N` until active tabs can read or reload into `N + 1`.
5. Sign with the installer-rooted release key. Any peer or mirror may distribute
   the byte-identical artifact; none may author a release.

Peer/mirror distribution minimizes engine traffic and lets a directly reachable
updated runner seed another. Update checks prefer peers with a verified newer
manifest and use the engine or configured mirror only when no peer has it.
Publisher signature, not source host, establishes authenticity. Executable bytes
remain outside ordinary application replication but use resumable, bounded,
hash-checked transfer.

### Version skew

Handshake fields include app release, peer protocol min/max, operation schema
min/max, snapshot version, blob/credential-plane capabilities, and replica
state.

- Common versions: full read/write/sync.
- Unknown optional fields: preserve and forward.
- Unsupported operation kind/schema: quarantine, require update, and disable
  affected writes; a negotiated turn may finish.
- No common protocol: close after a minimal signed error and retain local
  read-only app/data.
- Incompatible snapshot: choose another snapshot/peer or replay a retained
  compatible operation range. A joining runner cannot become ready without a
  complete compatible path.

The UI shows peer versions and compatibility. Cache invalidation is manifest
based and never requires today's engine `/app.js`.

## Transport and traffic constraints

The frame protocol is defined in
[replication.md](replication.md#peer-first-synchronization-protocol). WebSocket,
WebRTC, and opaque fallback adapters carry the same end-to-end authenticated
frames. Durable operation anti-entropy, blob transfer, ephemeral live streams,
and credential delivery are distinct logical channels with separate limits.

Credential channel constraints are stricter: runner endpoints only; mutual
owner-grant and target-key proof; no browser forwarding; no store-and-forward
relay that can read payloads; no inclusion in operation/snapshot/blob frontiers;
and delivery receipts reveal only credential/version/target identifiers. An
opaque byte relay may carry an already end-to-end encrypted live credential
frame, but cannot persist it as ordinary replicated data.

Minimize traffic without weakening full replicas:

- exchange compact frontiers and manifest trees before requesting bytes;
- deduplicate content by SHA-256 and resume chunks;
- choose one or several ready peers near the joining runner rather than routing
  a full bootstrap through the engine;
- coalesce live notifications while preserving durable operation boundaries;
- compress bounded batches and enforce per-channel flow control; and
- never repeatedly transfer a blob whose verified hash is already local.

Full replica means eventual byte completeness, not broadcast every byte to every
socket at once. Backpressure and resumable catch-up can bound bandwidth, but a
ready runner cannot declare quota-based permanent omissions.

## Degraded-mode user interface

The app separately reports route, engine control reachability, replica
completeness/redundancy, executor authority, credential availability, provider
reachability, and version. It never compresses these into one green/red dot. The
complete action contract is in
[trust-and-security.md](trust-and-security.md#degraded-mode-contract).

Persistent states include:

- **Direct — runner name:** command/data endpoint is the named peer.
- **Mesh — n peers:** direct anti-entropy is active.
- **Relay fallback:** explicit last-resort encrypted tunnel; reason and operator
  shown.
- **Joining replica — x/y operations, a/b blob bytes:** not redundancy-ready.
- **Full replica — local-only changes:** complete base plus writes awaiting a
  second durable runner receipt.
- **Full replica — redundant:** complete frontier/blobs acknowledged elsewhere.
- **Offline cache:** browser only; no executor route.
- **Authorization expires soon/expired:** exact time and remediation peer.
- **Update required/incompatible:** read-only where possible.

Pending requests show `local-only`, `replicating`, `queued`, `accepted`,
`executing`, `applied`, `rejected`, or `cancelled`. Only executor-accepted input
becomes canonical. Diagnostics show peer/frontier/version, path endpoints,
operation/blob lag, and unsynced byte counts without content or keys.

## Bounded transport research

- The [local-first essay](https://www.inkandswitch.com/essay/local-first/)
  treats local copies as primary and servers as secondary helpers.
- MDN's
  [WebRTC protocol overview](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Protocols)
  explains ICE/STUN/TURN and NAT limits. WebRTC's
  [peer connection guide](https://webrtc.org/getting-started/peer-connections)
  leaves signaling outside the specification, so optional engine rendezvous
  cannot be the only supported route.
- MDN documents `BroadcastChannel` as same-origin communication; it cannot
  bridge engine and runner origins.
- Chrome's
  [Local Network Access](https://developer.chrome.com/blog/local-network-access)
  work adds permissions around public-site access to loopback/LAN. Core offline
  use therefore starts at the runner-served origin.
