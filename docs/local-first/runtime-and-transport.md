# Runtime and transport

This document is normative detail for the
[local-first architecture](../local-first-architecture.md). Authentication,
credentials, tier behavior, and recovery are specified in
[trust-and-security.md](trust-and-security.md).

## Three distinct runtime roles

A runner, the Solid browser client, and the sync engine remain distinct security
and storage roles even when one machine or operator runs more than one:

```text
+----------------------+       private mesh       +----------------------+
| runner A             |<========================>| runner B             |
| full replica         |   direct / member relay  | full replica         |
| app/API/exec/vault   |                          | app/API/exec/vault   |
+----------^-----------+                          +-----------^----------+
           | bounded view queries / commands / live output   |
           +----------------------+---------------------------+
                                  |
                        +---------v----------+
                        | Solid client       |
                        | partial on-demand  |
                        | view/cache/drafts  |
                        +--------------------+

 runners .... independent entitled subscriptions .... sync engine
       (readable backup; linked anchor; never application A-to-B route)
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
origin so caches and cookies survive restarts. Before authentication, a dialed
endpoint reveals only the minimum handshake needed to prove its peer key and
protocol compatibility.

The route policy is short and invariant:

1. Use same-host, established authenticated, LAN, pinned public, or user
   VPN/overlay paths. Dial cached host, mapped, and peer-observed candidates in
   parallel; prefer a direct endpoint-authenticated path.
2. If two members each reach a third, that member exchanges their candidates
   over existing encrypted links and synchronizes a hole punch. Retain the
   direct path when it works.
3. If direct establishment fails, relay endpoint-encrypted frames through any
   mutually reachable member. An entitled account may instead use its existing
   paid engine relay convenience.
4. Otherwise report `No route`; never broker through the engine application
   WebSocket or backup subscription.

Engine health does not reorder this policy. Candidate exchange grants no account
membership, capability, data, credential, or execution authority; peers complete
the normal grant and nonce handshake before any application frame. A relaying
member is already trusted as a full account replica, but relay transport still
cannot bypass endpoint authentication or authorize the destination. The engine
relay has no endpoint keys or grants and sees only source/destination network
addresses, timing, allocation IDs, and byte volume—not endpoint-encrypted
application frames.

The readable engine backup remains a normal **destination subscriber** with tier
scope. Runner A and B may independently upload missing ranges; deduplication
makes one account frontier. A linked subscriber also participates in the private
mesh control plane as a stable anchor, and its paid relay may carry opaque live
frames, but neither role turns the application WebSocket or backup stream into a
runner data route. Endpoint-pair telemetry and capture tests distinguish direct
mesh, member relay, backup, and paid engine relay.

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

### Private-mesh discovery and NAT traversal

Once admitted, members keep persistent authenticated links when a route exists.
Each member gathers host candidates plus any explicit public endpoint and
opportunistic UPnP, NAT-PMP, or PCP mapping. Candidate sets always include IPv6
candidates, and members try IPv6 before any IPv4 punch. Connected peers report
the source address they observe for it. The member signs its candidate-set
version and expiry; peers gossip updates over encrypted member channels until
every member caches every other member's latest set. Keepalives preserve useful
NAT bindings but are bounded and adaptive. Except for the explicit consented
one-shot observation below, no candidate, presence record, or timing signal is
published to public STUN, a DHT, community rendezvous, or any other third-party
discovery network.

Members therefore provide the three network functions themselves:

- **Observed address:** reports from authenticated peers replace an external
  STUN oracle. Multiple observations reveal endpoint-dependent mappings.
- **Punch coordination:** a member reachable by both endpoints privately passes
  their current candidates and a short-lived attempt ID, then synchronizes
  outbound checks. One predictably mapped/reachable side is often enough. A
  successful authenticated path supersedes stale candidates and is gossiped.
- **Relay:** when a symmetric/symmetric or blocked pair cannot form a direct
  path, any mutually reachable member forwards bounded endpoint-encrypted live
  frames. It is the user's own hardware and already a full trusted replica. Paid
  users may choose the engine's existing live relay convenience. No relay is an
  offline inbox or authority shortcut.

An **anchor** is simply a mesh member expected to retain a stable candidate: a
port-forwarded or opportunistically mapped home runner, a VPS runner, or the
engine backup subscriber for a linked account. It needs no separate protocol or
server role. Every stable member automatically acts as a recovery meeting point
after other members move together. Setup recommends designating and testing at
least one, but never claims a guarantee: if all members change addresses at once
and no cached route or anchor remains reachable, the mesh is blacked out and the
UI asks for manual re-pairing. A user may designate a third-party-hosted anchor;
that operator then learns member addresses and timing and is trusted only for
connectivity, not data authority. It can coordinate candidate exchange and relay
live encrypted frames when configured. Q Mush ships no dedicated rendezvous
service in the baseline.

Onboarding is not discovery. An owner creates a compact QR/text/file admission
package containing the current candidate set for the mesh, always including IPv6
candidates, a one-use high-entropy PAKE/admission secret, expected owner key,
protocol range, attempt ID, and expiry. The joining runner dials those
candidates directly; successful transport still requires transcript confirmation
and an explicit signed member grant. Completion, cancellation, or expiry erases
the secret. The package may be carried by any side channel without revealing
account data or granting data access.

Manual offer/answer is the floor when no anchor survives a blackout and for
cross-account first contact. Each intended endpoint locally gathers candidates
and exchanges an encrypted, authenticated, expiring one-use offer and answer as
text/file/QR over a user-chosen side channel. A peer can also report the other's
observed address during this exchange. When no member has yet observed a device,
its user may consent to one address-observation query to a STUN server; it is
not registration or announcement. Import never auto-approves pairing, and
candidate possession never reveals a frontier. If synchronized checks and all
approved member/engine relays fail, show `No route`.

#### First contact: two home laptops

- **Same network once, including a momentary phone hotspot:** mDNS/QR direct;
  mesh caching handles later remote contact.
- **Both homes have IPv6:** direct simultaneous open before IPv4 punching.
- **Either router supports UPnP, NAT-PMP, or PCP:** that laptop maps a port and
  learns its public IP; the other dials it.
- **Neither router maps a port:** manual punch with a router-reported WAN tuple
  or the consented one-shot STUN observation.
- **Both have CGNAT or symmetric NAT, with no IPv6:** use an anchor or report
  `No route`. Asymmetric CGNAT is fine: that side dials outward.

In a two-device mesh, simultaneous address changes by both lone members cause a
blackout requiring an anchor or fresh offer/answer; one changed side re-knits
through the unchanged member.

### Rejected public discovery

A public DHT is rejected, not reserved for experiment: even opaque rotating keys
announce a member's IP and timing to strangers and add bootstrap, scraping,
Sybil/eclipse, poisoning, resource, and cross-platform complexity without
solving relay. Persistent public STUN use and standalone/community rendezvous
have the same baseline privacy mismatch. The single exception is the
user-consented one-shot observation above when no member has observed a device
for first contact; it is never registration or announcement. A user-designated
third-party anchor can expose the same private observed-address,
punch-coordination, and live-relay protocol as a stable member without joining
the data replica set. This is different only because the user explicitly chooses
that address recipient. The private mesh, onboarding package, and manual
exchange cover the baseline with one mechanism.

A runner also accepts a pinned HTTPS URL, user VPN, reverse tunnel, or overlay.
Browsers cannot accept arbitrary inbound TCP, so browser-to-runner remote access
uses pinned HTTPS/WebSocket or WebRTC. Candidate exchange grants no data
authority in every path.

### Browser connectivity

Browsers connect outward only:

- same runner origin: authenticated HTTP/WebSocket, with optional local
  `BroadcastChannel` transport ownership;
- remote runner: pinned HTTPS/WebSocket or WebRTC, reached from the private
  mesh's cached candidates, member-coordinated punching, an admission package,
  or manual offer/answer; and
- no direct path: a mutually reachable member relay or the paid engine relay.

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
exclude browser forwarding and persistent relay storage. A member or paid engine
relay may carry already endpoint-encrypted frames. Engine backup parses ordinary
data to enforce entitlement but receives no credential frame type.

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

- **Connecting through cached candidates** or **Punching via — runner name**;
- **Direct — runner name**, **Mesh — n runners**, and **Anchor — runner name**;
- **Member relay — runner name** or **Paid engine relay**;
- **No route** with actions to wake/test the anchor, copy an offer, re-pair, add
  a stable member, or configure an explicit third-party anchor—never an implicit
  public-discovery or engine-application fallback;
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
relevant implementation documentation; no library is selected by this design. A
2026 deep-research pass (report retained outside the repository at
`~/q-mush-workspaces/DEEP_RESEARCH.md`) validated the member-mesh model:
member-provided observation, coordination, and relay are production patterns in
[Tailscale](https://tailscale.com/blog/how-nat-traversal-works),
[iroh](https://www.iroh.computer/docs/concepts/dialing), and
[libp2p](https://github.com/libp2p/specs/blob/master/relay/DCUtR.md). It also
confirmed that two hard-NAT peers need a relay and a simultaneous two-device
address blackout needs an anchor or human exchange.
[RFC 4787](https://datatracker.ietf.org/doc/html/rfc4787), the
[DCUtR measurement study](https://arxiv.org/abs/2510.27500), and the expired,
informative
[QUIC NAT traversal draft](https://datatracker.ietf.org/doc/draft-seemann-quic-nat-traversal/)
provide NAT evidence and QUIC-native punching prior art for Stage 4.

- The [local-first essay](https://www.inkandswitch.com/essay/local-first/)
  treats local copies as primary and servers as secondary helpers.
- [WireGuard](https://www.wireguard.com/) demonstrates authenticated peer
  endpoint roaming, and its [quick start](https://www.wireguard.com/quickstart/)
  documents optional persistent keepalives for retaining NAT/firewall mappings.
  Q Mush similarly treats addresses as changing hints beneath stable peer keys.
- [ICE (RFC 8445)](https://datatracker.ietf.org/doc/html/rfc8445) and
  [JSEP (RFC 9429)](https://datatracker.ietf.org/doc/html/rfc9429) separate
  candidate checking from offer/answer transport; Q Mush uses the checking model
  but keeps candidate exchange private. UPnP, NAT-PMP, and
  [PCP (RFC 6887)](https://datatracker.ietf.org/doc/html/rfc6887) are
  opportunistic reachability improvements, never dependencies.
- A public DHT is intentionally absent: BitTorrent
  [BEP 5](https://www.bittorrent.org/beps/bep_0005.html) stores an announcing
  peer's IP/port even when the lookup key itself is opaque, which violates the
  address-privacy rule.
- `BroadcastChannel` is same-origin and cannot bridge engine/runner origins.
- Chrome's
  [Local Network Access](https://developer.chrome.com/blog/local-network-access)
  adds permissions around public-site access to loopback/LAN, so core local use
  starts at the runner-served origin.
