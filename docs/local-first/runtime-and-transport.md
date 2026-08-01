# Runtime and transport

This document is normative detail for the
[local-first architecture](../local-first-architecture.md). Authentication,
credentials, tier behavior, and recovery are specified in
[trust-and-security.md](trust-and-security.md).

## Three distinct runtime roles

A runner, the Solid browser client, and the sync engine remain separate security
and storage roles even when one machine runs more than one of them:

```text
+----------------------+       direct mesh       +----------------------+
| runner A             |<=======================>| runner B             |
| full replica         |                         | full replica         |
| app/API/exec/vault   |                         | app/API/exec/vault   |
+----------^-----------+                         +-----------^----------+
           | bounded view queries / commands / live output  |
           +----------------------+--------------------------+
                                  |
                        +---------v----------+
                        | Solid client       |
                        | partial on-demand  |
                        | view/cache/drafts  |
                        +--------------------+

 runners .... independent entitled subscriptions .... sync engine
            (readable backup; never A-to-B route)
```

Serving the Solid assets from a runner does not merge the browser JavaScript
process with the runner replica. The browser has no full-log subscription,
replica frontier, readiness state, compaction vote, or credential channel. It
queries a reachable runner for the current session list/page/detail, workspace,
prompt, settings, or attachment range; bounded invalidations trigger refetch. It
may cache those responses and local drafts for usability, but those bytes are
not durability evidence. Shared edits are commands submitted to a runner, not
browser-originated replicated operations.

## Peer-first runner topology

Every runner starts a loopback app/API/peer listener by default and may
explicitly enable a paired LAN or remote listener. Persist its port/stable local
origin so caches and cookies survive restarts. Discovery reveals only opaque
peer ID, candidates, and protocol versions before authentication.

Route policy is invariant:

1. Use a same-host runner WebSocket where available.
2. Prefer direct authenticated runner WebSocket/TLS, LAN, user VPN/overlay, or
   established WebRTC transport.
3. Use cached/manual candidates to establish another direct route.
4. For paid logged-in accounts only, after direct establishment fails, policy
   may select the managed end-to-end encrypted relay/TURN service. Label it
   `Relay fallback`.
5. Otherwise report `No route`; never broker through the engine application
   WebSocket.

Engine health does not change this order. Paid rendezvous exchanges signed,
opaque candidates or signaling, but ordinary operations, blobs, commands,
receipts, and streams still traverse endpoint-authenticated peer sessions. The
paid relay has no endpoint keys or grants and cannot terminate, inspect,
authorize, merge, or store-and-forward application frames. Anonymous/free users
can use LAN, manual exchange, directly reachable addresses, or their own
VPN/relay infrastructure; managed engine rendezvous/relay is not an entitlement
for free mode.

The readable engine backup is a normal **destination subscriber** with tier
scope. Runner A and runner B may independently upload their own missing ranges;
deduplication makes the result one account frontier. The engine cannot serve
those live links as the A-to-B route. Endpoint-pair telemetry and capture tests
must distinguish direct mesh, backup, rendezvous signaling, and opaque relay.

### Same host and Solid views

A client opened from `http://127.0.0.1:<port>/app` (or a stable loopback
hostname) uses a same-origin authenticated API/WebSocket to that runner. This is
the core outage path: the runner serves assets and on-demand projections,
accepts commands, and introduces runner peers. Multiple tabs at the same origin
may use `BroadcastChannel` solely to elect one browser transport owner, share
view invalidations, and coordinate drafts. Tabs remain clients, **not logical
replication peers**, and `BroadcastChannel` traffic never contains operation
ranges or acknowledgements.

An engine-served migration app may connect outward to a paired runner, but the
target never depends on a public page reaching loopback through Local Network
Access exceptions. Engine and runner origins cannot use `BroadcastChannel`
together.

### LAN

An explicitly LAN-enabled runner binds a private interface and advertises a
DNS-SD service such as `_qmush._tcp` with protocol/app version, port, and opaque
peer-key fingerprint. The runner process browses mDNS. A user opens the `.local`
URL or enters/scans an address and pairs.

Private addressing is not trust. Write-capable LAN mode requires stable HTTPS
with a pinned runner certificate or loopback termination through a native
helper. Stage 1 is loopback-only. Until secure onboarding works, opt-in plain
HTTP LAN access is read-only and visibly warned, or disabled.

### Remote networks and NAT

A runner accepts a pinned manual HTTPS URL, including user VPN, reverse tunnel,
or overlay. WebRTC ICE may need STUN/TURN, and browsers cannot accept arbitrary
inbound TCP. Candidate sources are reachable runners, local cache, manual
QR/copy-paste, and paid engine rendezvous. Candidate exchange grants no data
authority.

If signaling/relay fails before exchange, a new route may be impossible. Remote
outage operation therefore needs an existing WebRTC path/cached ICE, pinned
reachable runner URL, shared LAN/VPN, manual one-time offer/answer, or
separately reachable encrypted relay. Manual exchange is supported, not a debug
path. P2P cannot defeat every NAT; honest `No route` is preferable to implicit
brokerage.

### Browser connectivity

Browsers connect outward only:

- same runner origin: authenticated HTTP/WebSocket, with optional local
  `BroadcastChannel` transport ownership;
- remote runner: pinned HTTPS/WebSocket or WebRTC, signaled by a runner, manual
  exchange, or entitled rendezvous; and
- no direct path: explicitly approved encrypted relay if available.

A browser can submit bounded queries and commands and receive live events. It
cannot carry anti-entropy on behalf of runners, qualify as redundancy, or
receive secrets. WebRTC encryption does not replace Q Mush client/runner
authentication.

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

The runner serves it without Vite/sources. Hashed assets are immutable; manifest
and shell use ETag. A service worker may cache verified app assets and a prior
release, but never API projections, operation data, or credential traffic. Any
browser data cache is explicit application storage with partial-view semantics.

`sync-engine/client-build.ts` already points Vite at `solid/client.tsx`, while
`sync-engine/server.ts` consumes output. Refactor one build artifact producer
for runner packaging and temporary engine migration hosting; do not duplicate
the Solid build.

### Existing update chain

The existing engine fingerprints/cross-compiles runner sources and the runner
hash-checks then atomically replaces itself. Extend it:

1. Build one signed web manifest/assets set.
2. Embed digest/compatibility in the runner executable fingerprint.
3. Verify, drain execution, atomically replace, and restart.
4. Keep release `N` until tabs can reload into `N + 1`.
5. Trust an installer-rooted release signature, not the download host.

Peers or mirrors may distribute identical artifacts. Checks prefer a verified
newer peer and use engine/mirror only when needed. Executable bytes are not
application replication but use resumable bounded hash-verified transfer.

### Version skew

Runner handshakes include release, peer protocol range, operation schema range,
snapshot version, blob/credential capabilities, tier partition, and replica
state.

- Common versions permit normal read/write/sync.
- Preserve unknown optional fields.
- Unsupported operation kinds quarantine and disable affected writes.
- No common protocol closes after a signed error while local compatible reads
  remain.
- Incompatible snapshots require another peer/snapshot or retained operation
  range; a joining runner cannot become ready without a complete path.

Browser API negotiation is separate and exposes only supported view/query and
command versions. A stale Solid release never receives raw unknown operation
kinds. The UI shows compatibility and uses manifest-based cache invalidation,
not today's engine `/app.js` dependency.

## Transport and traffic constraints

The frame protocol is in
[replication.md](replication.md#peer-first-synchronization-protocol). Direct
WebSocket/WebRTC and opaque relay adapters carry endpoint-authenticated runner
frames. Durable anti-entropy, blobs, streams, engine-backup subscription,
view/query traffic, and credentials are separate limited channels.

Credential channels allow runner endpoints only, require target-key proof, and
exclude browser forwarding and persistent relay storage. An opaque live relay
may carry already endpoint-encrypted frames. Engine backup parses ordinary data
to enforce entitlement but receives no credential frame type.

Minimize traffic without weakening runner completeness:

- compare compact partitioned frontiers/manifest trees before byte requests;
- deduplicate by SHA-256 and resume chunks;
- bootstrap from nearby ready runners instead of engine hairpinning;
- coalesce browser invalidations and live notifications;
- paginate/query only the active Solid view;
- compress bounded batches with per-channel flow control; and
- never retransmit a verified blob hash unnecessarily.

A full runner means eventual byte completeness, not immediate broadcast to every
socket. A browser remains intentionally partial forever. A logged-in engine is
complete only for the tier partition through its displayed backup frontier.

## Degraded-mode user interface

Report route, runner completeness, engine backup scope/frontier, entitlement,
executor authority, credential availability, provider reachability, and version
separately. Persistent states include:

- **Direct — runner name** and **Mesh — n runners**;
- **Relay fallback** (paid managed or named user-provided operator);
- **Joining runner — x/y operations, a/b blob bytes**;
- **Full runner — local-only changes** or **runner-redundant**;
- **Engine backup — non-session**, **all data**, **pending**, or **not available
  (anonymous)**;
- **Solid partial view — cached/offline**; never “replica” and never a quorum
  member;
- **Authorization expires soon/expired**; and
- **Update required/incompatible**.

Commands show `draft`, `submitting`, `runner-local`, `replicating`, `queued`,
`accepted`, `executing`, `applied`, `rejected`, or `cancelled`. A browser draft
is not `local-only` shared data; only a runner commit earns that label. Session
views for free users warn that engine backup excludes them. Upgrade backfill and
downgrade grace/purge are visible. Diagnostics show IDs, frontiers, endpoints,
versions, lag, and byte counts without paths, content, or keys.

## Bounded transport research

- The [local-first essay](https://www.inkandswitch.com/essay/local-first/)
  treats local copies as primary and servers as secondary helpers.
- MDN's
  [WebRTC protocol overview](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Protocols)
  and the
  [peer connection guide](https://webrtc.org/getting-started/peer-connections)
  explain ICE/STUN/TURN and leave signaling unspecified; engine rendezvous
  cannot be the sole route.
- `BroadcastChannel` is same-origin and cannot bridge engine/runner origins.
- Chrome's
  [Local Network Access](https://developer.chrome.com/blog/local-network-access)
  adds permissions around public-site access to loopback/LAN, so core local use
  starts at the runner-served origin.
