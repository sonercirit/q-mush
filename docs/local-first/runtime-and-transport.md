# Runtime and transport

This document is normative detail for the
[local-first architecture](../local-first-architecture.md). Authentication,
credentials, tier behavior, and recovery are specified in
[trust-and-security.md](trust-and-security.md).

## Four distinct runtime roles

A runner, the Solid browser client, the sync engine, and the separately
deployable connectivity service remain distinct security and storage roles even
when one machine or operator runs more than one:

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

 runners .... opaque discovery / optional encrypted .... connectivity service
                       live relay                 (self-hosted or managed)
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
2. Prefer direct authenticated runner WebSocket/TLS over LAN, a pinned public
   address, user VPN/overlay, or established WebRTC.
3. To establish remote first contact, try cached candidates and parallel
   user-configured discovery sources: self-hosted/community rendezvous and
   public-STUN ICE descriptions exchanged manually over any side channel. The
   paid managed rendezvous is another configured source, not a privileged peer
   protocol.
4. Run ICE connectivity checks and upgrade any signaling/relayed introduction to
   a direct endpoint-authenticated path when possible.
5. If direct establishment fails, use only an explicitly configured and labeled
   endpoint-encrypted relay/TURN allocation: self-hosted/community for any user,
   or the paid managed deployment for entitled users.
6. Otherwise report `No route`; never broker through the engine application
   WebSocket.

Engine health does not reorder this policy. All rendezvous deployments exchange
only short-lived opaque lookup values and endpoint-encrypted descriptors with
candidates and signaling. Candidate exchange grants no account membership,
capability, data, credential, or execution authority; peers complete the normal
grant and nonce handshake before any application frame. A relay has no endpoint
keys or grants and cannot terminate, inspect, authorize, merge, or
store-and-forward application frames. Its operator can still observe
source/destination network addresses, timing, allocation IDs, and byte volume.

The **connectivity service** is a small separately deployable artifact and
protocol, not a mode of the sync-engine application WebSocket. It combines an
opaque authenticated rendezvous API with STUN/TURN or an equivalent bounded live
byte relay. Q Mush publishes a container/binary, configuration schema, and
operator guide; users may point runners at one or more deployments. The managed
paid service runs the same protocol as one deployment and adds engine-issued
short-lived service entitlement only at its admission edge. The standalone
service accepts its own operator-selected authentication/rate policy and never
calls Q Mush billing. Client code does not entitlement-gate self-hosted,
community, public-STUN, manual, LAN, or VPN paths.

The readable engine backup remains a normal **destination subscriber** with tier
scope. Runner A and B may independently upload missing ranges; deduplication
makes one account frontier. Neither the backup endpoint nor engine application
socket can serve their live route. Endpoint-pair telemetry and capture tests
distinguish direct mesh, backup, every rendezvous source, and opaque relay.

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

### Remote first contact and NAT

This section covers both returning account peers and admission of a never-paired
runner. Remote discovery and reachability are separate. A discovery result is an
untrusted hint; possession of an opaque lookup value or offer is not a bearer
credential. A runner reveals no frontier or stable account ID until the peer
proves its device key and account grant.

Q Mush combines two engine-independent first-contact paths:

1. **Configured standalone rendezvous/relay.** Returning account peers derive a
   rotating discovery topic with domain-separated HKDF from a secret replicated
   only to admitted runners. For a new runner, the owner creates a separate
   one-use high-entropy admission topic/secret; no account key is disclosed
   before approval. Topics are opaque and unlinkable to account IDs without the
   applicable secret. A runner registers a short-lived descriptor signed by the
   ephemeral rendezvous key and containing protocol range, expiry, and ICE
   candidates encrypted to that topic secret. A peer queries the topic, decrypts
   and verifies locally, then runs ICE. Deployments require bounded TTL,
   pagination, registration proof, replay rejection, rate/size limits, and no
   application payload persistence. A user may configure several self-hosted/
   community URLs; the new runner receives a service URL and one-use secret in
   its onboarding package—not prior IP connectivity or an account authority key.
   This is remote first contact despite using a human onboarding side channel:
   no existing peer route, public address, engine, or VPN is assumed. After the
   route forms, owner confirmation and the normal grant protocol admit it;
   cancelling or completing admission erases the one-use secret.
2. **Hardened manual ICE.** Either runner gathers host and server-reflexive
   candidates from configurable public or private STUN servers (and relayed
   candidates when the user supplies TURN), emits a compact
   encrypted/authenticated offer as text/file/QR, and accepts an answer returned
   through email, messenger, phone, removable media, or any arbitrary side
   channel. The package binds a random attempt ID, both expected peer keys when
   known, ICE credentials/candidates, expiry, protocol version, and transcript
   confirmation; it is one-use and contains no account ID or data authority.
   Trickle updates are optional; a bounded full-gather offer/answer always works
   without a live signaling service. Import never auto-approves pairing. An
   offer reaches the intended peer through the package's one-use PAKE/admission
   secret and transcript confirmation, or—between admitted peers—by encryption
   to the expected device key; transport encryption alone is insufficient.

Public STUN is only an address oracle and receives no account topic, offer, or
application data, though it observes the caller IP and timing. STUN plus
signaling does not guarantee a route: endpoint-dependent/symmetric NAT, UDP
blocking, or restrictive firewalls can require TURN. The configured standalone
component therefore includes relay capability and manual descriptions may name
user-supplied TURN credentials. If no allowed relay exists and direct ICE fails,
show `No route`—never substitute the engine application WebSocket.

### Why no public DHT in the baseline

A public Kademlia/BitTorrent-style DHT could publish provider records under the
same rotating returning-peer or one-use admission topics, removing a named
rendezvous operator. Opaque keys hide the account name from outsiders who lack
the key, but publishing still exposes a live runner's IP/multiaddress and timing
to DHT nodes and any party that learns or guesses the topic; network-wide
queries invite scraping, correlation, poisoning, eclipse/Sybil, replay, and
amplification defenses. It also adds a substantial P2P stack, bootstrap-node
policy, record validation, NAT behavior, resource limits, and cross-platform
maintenance to a project that still needs TURN/circuit relay for hard NATs. A
DHT discovers candidates but is not a relay.

Accordingly DHT rendezvous is **evaluated but not shipped in the baseline**. The
pluggable discovery interface reserves a versioned `dht` source, and an
experiment may compare implementation weight, reachability, abuse resistance,
and metadata leakage. It cannot be enabled by default or advertised as private
until that review passes; it would remain free of Q Mush entitlement and would
not remove the relay/manual paths.

A runner also accepts a pinned HTTPS URL, user VPN, reverse tunnel, or overlay.
Browsers cannot accept arbitrary inbound TCP, so browser-to-runner remote access
uses pinned HTTPS/WebSocket or WebRTC. Candidate exchange grants no data
authority in every path.

### Browser connectivity

Browsers connect outward only:

- same runner origin: authenticated HTTP/WebSocket, with optional local
  `BroadcastChannel` transport ownership;
- remote runner: pinned HTTPS/WebSocket or WebRTC, signaled by a runner,
  standalone/managed rendezvous, or manual offer/answer; and
- no direct path: an explicitly configured endpoint-encrypted standalone,
  community, user TURN, or paid managed relay.

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

- **Discovering — local**, **standalone — operator name**, **managed**, or
  **manual offer waiting/expired**;
- **Direct — runner name** and **Mesh — n runners**;
- **Relay fallback — operator name** with self-hosted/community/managed label;
- **No route** with the failed direct/STUN/rendezvous/relay attempts and actions
  to copy an offer or configure a service, never an implicit engine fallback;
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

Research was intentionally bounded to protocol specifications and directly
relevant implementation documentation; no library is selected by this design.

- The [local-first essay](https://www.inkandswitch.com/essay/local-first/)
  treats local copies as primary and servers as secondary helpers.
- [ICE (RFC 8445)](https://datatracker.ietf.org/doc/html/rfc8445) gathers host,
  server-reflexive STUN, and relayed TURN candidates and deliberately leaves
  offer/answer exchange to the application.
  [JSEP (RFC 9429)](https://datatracker.ietf.org/doc/html/rfc9429) likewise
  separates WebRTC negotiation from the signaling mechanism, supporting
  arbitrary side-channel offer/answer.
- [TURN (RFC 8656)](https://datatracker.ietf.org/doc/html/rfc8656) is the relay
  fallback when NAT/firewall behavior prevents direct communication; operating
  rendezvous or a DHT cannot eliminate this residual bandwidth role.
- The
  [libp2p rendezvous specification](https://github.com/libp2p/specs/tree/master/rendezvous)
  uses expiring namespace registration at a rendezvous point, while its
  [Kademlia DHT](https://github.com/libp2p/specs/tree/master/kad-dht)
  illustrates the extra bootstrap/routing stack and client/server split for
  NATed nodes. [BitTorrent BEP 5](https://www.bittorrent.org/beps/bep_0005.html)
  explicitly stores announcing peer IP/port under an infohash, demonstrating why
  an opaque DHT key does not hide presence metadata.
- `BroadcastChannel` is same-origin and cannot bridge engine/runner origins.
- Chrome's
  [Local Network Access](https://developer.chrome.com/blog/local-network-access)
  adds permissions around public-site access to loopback/LAN, so core local use
  starts at the runner-served origin.
