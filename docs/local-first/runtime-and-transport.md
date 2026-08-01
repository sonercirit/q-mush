# Runtime and transport

This document is normative detail for the
[local-first architecture](../local-first-architecture.md). Authentication,
secret handling, degraded behavior, and security are specified in
[trust-and-security.md](trust-and-security.md).

## Peer addressing and topology

Every runner starts a loopback app/API listener by default and may enable a
paired LAN/remote listener explicitly. Its port is configurable and persisted.
The loopback URL uses a stable local origin so IndexedDB, service-worker state,
and cookies survive restarts. Discovery exposes only an opaque peer ID,
connection candidates, and protocol versions; private metadata appears only
after authentication.

### Same host and tabs

A tab opened from `http://127.0.0.1:`\<port>`/app` (or a stable loopback
hostname) uses a same-origin WebSocket to the runner. This is the most reliable
outage path: the runner serves both app and local API. An engine-served app may
connect outward to a paired loopback runner, but the core path does not depend
on public to local cross-origin requests, which browser Local Network Access
protections may gate.

Same-origin tabs use `BroadcastChannel` to elect one transport owner per browser
profile/origin and fan out operation notifications. Every tab is still a logical
peer, but one connection avoids redundant anti-entropy. Engine-origin and
runner-origin tabs cannot meet through `BroadcastChannel`; they use the peer
transport.

### LAN

An explicitly LAN-enabled runner binds a private interface and advertises a
DNS-SD service such as `_qmush._tcp` with protocol/app version, port, and an
opaque peer-key fingerprint. The runner process performs mDNS browsing; ordinary
web pages cannot be assumed to have multicast APIs. A user opens the advertised
`.local` URL or enters a shown address/QR code and pairs.

Private addressing is not trust. Write-capable LAN mode requires a stable HTTPS
origin with a pinned runner certificate (or loopback termination through a
native helper). Stage 1 is loopback-only. Until certificate onboarding is
usable, any opt-in plain-HTTP LAN mode is read-only and visibly warned.

### Remote networks and NAT

The runner accepts a manual HTTPS URL, including a user VPN, reverse tunnel, or
overlay. While online, the engine distributes signed candidate lists and acts as
WebRTC signaling/rendezvous. It may offer STUN and an encrypted relay/TURN
fallback, but a relay is connectivity infrastructure, not plaintext authority.

WebRTC ICE may require STUN or TURN to cross firewalls and NAT, and a browser
cannot accept arbitrary inbound TCP. If the engine was the only signaling or
relay path and fails before candidates are exchanged, a new remote route may be
impossible. Q Mush reports “no route to runner”; P2P cannot defeat every NAT.
Remote outage use needs at least one existing route:

- an open/recoverable WebRTC connection;
- a pinned, directly reachable HTTPS runner URL;
- shared LAN or user VPN/overlay; or
- a separately deployed end-to-end encrypted relay.

Manual one-time offer/answer exchange by QR/copy-paste supports engine-free
bootstrap as a fallback, not silent discovery.

### Browser-to-browser

Tabs have no listener, so they connect out:

- same origin: `BroadcastChannel`;
- different origins/devices: WebRTC `RTCDataChannel`, signaled by a reachable
  runner, the engine, or manual exchange;
- no WebRTC route: any mutually reachable runner or encrypted relay.

A tab may relay authorized operations, but cannot execute a session or receive
runner-vault secrets. WebRTC transport encryption does not replace Q Mush peer
authentication and workspace authorization.

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

The runner serves it without Vite or sources. Hashed assets use long-lived
immutable caching; the manifest and shell use ETag revalidation. The shell
references only its manifest's hashes. A later service worker precaches one
verified release and retains the prior compatible release for rollback; it never
caches API or secret responses.

`sync-engine/client-build.ts` already points Vite at `solid/client.tsx`, and
`sync-engine/server.ts` reads the JavaScript/CSS output. Refactor this into one
build-time artifact producer for both engine and runner packaging rather than
creating another Solid build configuration.

### Existing update chain

`sync-engine/runner-executable.ts` fingerprints runner source plus Bun
version/revision, cross-compiles in a private temporary directory, caches by
target, and serves ETag and SHA-256. `runner/runner-update.ts` sends
`If-None-Match`, bounds and verifies the download, atomically replaces the
executable, and restarts after a drain. `runner/runner-agent.ts` checks at
startup, every five minutes, and on an advertised version change.

Extend that chain:

1. Produce the web manifest/assets once from the existing Vite build.
2. Include their digest and peer compatibility range in the runner fingerprint.
   Embed the release in the executable by default, satisfying the requirement
   that every runner contains the app; a signed appended archive is acceptable
   only if verified before startup.
3. Verify executable and manifest, drain active sessions, atomically replace,
   and restart. Never accept executable code from a discovered peer.
4. Keep release `N` until its active tabs can read or reload into `N + 1`.
5. Publish with an engine release key rooted in the installer. A peer may later
   relay a byte-identical signed artifact but cannot author one.

A digest proves response integrity; a signature pins publisher authenticity for
relayed artifacts.

### Version skew

The handshake advertises app release, peer protocol min/max, operation schema
min/max, snapshot version, and capabilities.

- Common versions: full read/write/sync.
- Unknown optional fields: preserve and forward.
- Unsupported operation kind/schema: quarantine the bytes, require update, and
  disable affected writes. A negotiated current turn may finish.
- No common peer protocol: close after a minimal signed error and keep local
  read-only data/app.
- Incompatible snapshot: fall back to supported operations.

The UI shows peer versions and compatibility. Cache invalidation is
manifest-driven, not dependent on every host serving today's unversioned
`/app.js`.

## Transport protocol

The transport-independent sync frames are defined in
[replication.md](replication.md#synchronization-protocol). WebSocket, WebRTC,
and relay adapters carry the same authenticated frames. Reuse the domain shapes
in `shared/user-realtime-protocol.ts`, `solid/realtime-client-codec.ts`, and
`sync-engine/realtime.ts` where possible, while separating durable operations
from ephemeral presence/model/tool stream deltas.

## Degraded-mode user interface

The app reports control-plane reachability, replication health, runner route,
executor authority, credential availability, and model-provider reachability
separately. It never compresses these into one green/red “online” dot. The
complete action contract is in
[trust-and-security.md](trust-and-security.md#degraded-mode-contract).

The persistent header exposes these modes:

- **Direct — runner name:** executor path bypasses the engine.
- **Mesh — n peers:** direct replication active.
- **Syncing — n local changes:** anti-entropy in progress.
- **Offline cache:** no executor route; only cached/queued actions work.
- **Authorization expires soon/expired:** exact time and remediation.
- **Update required/incompatible:** read-only where possible.

Pending requests show durable state: `local`, `relayed`, `accepted`,
`executing`, `applied`, `rejected`, or `cancelled`. Only executor-accepted input
becomes a canonical transcript message; local requests remain in the pending
area. Prompt conflicts retain both revisions with compare/restore. Diagnostics
show peer/frontier/version and unsynced byte counts without keys.

## Bounded transport research

- The [local-first essay](https://www.inkandswitch.com/essay/local-first/)
  defines the network as optional and local copies as primary, with servers as
  secondary helpers.
- MDN's
  [WebRTC protocol overview](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Protocols)
  explains ICE, STUN, TURN, firewall, and NAT constraints. WebRTC's
  [peer connection guide](https://webrtc.org/getting-started/peer-connections)
  says signaling is outside the specification. The engine therefore cannot be
  the only rendezvous/relay if remote outage use is promised.
- MDN documents `BroadcastChannel` as same-origin tab/window/worker
  communication; it cannot bridge engine and runner origins.
- Chrome's
  [Local Network Access](https://developer.chrome.com/blog/local-network-access)
  work adds permissions around public-site access to loopback/LAN. Core offline
  use therefore starts at the runner-served origin.
