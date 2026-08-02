# Alternatives and open questions

This document records rejected approaches and genuine follow-up decisions for
the [local-first architecture](../local-first-architecture.md). Open questions
may tune policy; they cannot weaken full runner replicas, partial-view browsers,
optional login, entitlement-filtered readable backup, engine-independent remote
first contact, runner-side provider authorization, or the peer-first data plane
without a newly accepted design.

## Alternatives considered

- **Authoritative engine plus service worker:** rejected. Cached assets do not
  replace auth, orchestration, state, provider calls, or command routing.
- **Engine fan-out while online, P2P only during outage:** rejected. Ordinary
  runner traffic is peer-first at all times. The engine may independently
  subscribe to entitled backup data, act as the linked account's stable anchor,
  and offer paid endpoint-encrypted live relay, but it never terminates A-to-B
  replication.
- **Optional, disabled, or E2EE-blind engine backup:** rejected by the
  total-runner-loss requirement. Once a user links, readable backup is
  default-on for the tier partition: non-session for free, all ordinary data for
  paid.
- **Same backup scope for free and paid:** rejected as an explicit business
  decision. Free preserves account/configuration but deliberately loses all
  session entities/session-only blobs after total runner loss; paid preserves
  them.
- **Require Google before local use:** rejected. Anonymous account genesis is
  device-key-rooted and supports local/peer operation. Google gates engine
  identity, backup, the linked engine anchor, the paid relay, and recovery only;
  private-mesh/manual connectivity remains available to all users.
- **Recreate an account during login:** rejected. Anonymous-to-logged-in linking
  retains IDs, operations, trust root, peers, sessions, and blobs, with explicit
  merge if the Google identity already has remote data.
- **Make every browser a replica/peer:** rejected. It creates quota,
  confidentiality, lifecycle, and false-durability problems. Solid is a partial
  query/cache client and never emits replica/compaction acknowledgements.
- **Browser offline operation outbox:** rejected for this design. A disconnected
  browser may preserve drafts, but only a runner accepts a shared operation.
  This keeps replica membership and causal safety runner-only.
- **Leave remote recovery to paid engine service, VPN, or remembered
  addresses:** rejected. The private mesh itself gossips all member candidates,
  reports observed addresses, coordinates punching, and relays. Onboarding
  packages carry the current candidate set; manual offer/answer covers blackout
  recovery and cross-account first contact.
- **Ship a dedicated standalone/community rendezvous plus TURN service:**
  rejected as unnecessary baseline infrastructure. Any stably reachable member
  is already an anchor and any mutually reachable member can coordinate or
  relay. A third-party-hosted anchor remains an explicit user choice with its
  address-metadata exposure, not a default discovery network.
- **Use public STUN or a public DHT:** rejected. Nobody announces a member's
  address or timing to third-party discovery networks. Opaque rotating DHT keys
  do not hide the announcing IP, add bootstrap/Sybil/eclipse/poisoning and
  dependency weight, and still do not relay hard-NAT traffic. Q17's DHT
  experiment is dead for this privacy reason.
- **Treat candidate exchange as pairing:** rejected. Private mesh gossip,
  admission/manual packages, observed-address reports, and punch coordination
  provide route hints only. Endpoint key, grant, nonce, and explicit admission
  checks still gate all data.
- **Use a dedicated discovery network when mesh recovery fails:** rejected. The
  backup/application channel is never an A-to-B route; use an approved member or
  paid engine relay, manual exchange, or report `No route`.
- **Engine provisioning for API/generic/Brave secrets:** rejected. Runner vaults
  and per-target envelopes distribute them without unrelated control traffic.
- **Put sealed envelopes in ordinary replication/readable backup:** rejected. It
  expands copying/retention and erasure ambiguity. Replicate only sanitized
  summaries/policy/receipts.
- **Entitlement-gate mesh connectivity:** rejected. Free and anonymous users may
  gossip candidates, use member observation/punching/relay, map a local router,
  exchange onboarding/manual packages, and use LAN, pinned, or VPN routes. Only
  the existing engine relay convenience is paid.
- **Engine-hosted OpenAI callback:** rejected. The current default loopback
  listener is on engine localhost port `1455`, which production cannot map to
  the user's device. Replace it with runner-side device authorization.
- **Keep OpenRouter on the engine merely because it has a callback:** rejected
  for the currently implemented provider contract. The caller supplies
  `callback_url`, PKCE protects exchange, and no registered client secret
  exists; a runner can host it. Reassess only if provider requirements change.
- **Engine-issued certificate for every admission:** rejected. Anonymous genesis
  and trusted owner devices sign grants/revocations; Google is only external
  binding/recovery.
- **Workspace/assignment-scoped runner replicas:** rejected. Every enrolled
  runner stores all account data and blobs, regardless of tier or executor.
- **Copy all `sync-engine/` code to runners:** rejected. It spreads Google,
  multi-account, billing, release, and legacy vault concerns and violates import
  boundaries. Extract narrow runtime-neutral pieces.
- **Timeout takeover/election:** rejected because an old runner may execute
  during a partition. Use fenced handoff or visible recovery fork.
- **Replicate SQLite/SQL, row-wide LWW, or generic CRDT database:** rejected.
  Representations differ and domain rules must preserve causality, authority,
  blobs, tiers, secrets, and soft deletion.
- **WebRTC for every link:** rejected. Direct WebSocket is simpler on
  loopback/LAN and for bulk runner catch-up; WebRTC serves reachability needs.
- **One account-wide credential key:** rejected. Independent target keys make
  compromise, rotation, and receipts bounded.
- **Lazy runner attachments/metadata-only readiness:** rejected. Ready runners
  retain every accepted blob; admission/capacity handles growth.

## Resolved decision: private-mesh discovery (former Q7)

Question 7 is resolved more simply: discovery is a private mesh function, not a
service ladder. Members keep authenticated links, privately gossip every
member's signed candidate set, report observed addresses, coordinate
synchronized punches, and relay through a mutually reachable member when direct
paths fail. Any stable member is an anchor; setup recommends a
port-forwarded/mapped home runner, VPS runner, or the linked engine backup
subscriber. Admission packages carry current candidates directly, so onboarding
needs no discovery. Manual offer/answer is the honest floor for a no-anchor
total-move blackout and cross-account first contact. The existing paid engine
relay remains a convenience; otherwise return `No route`.

No dedicated rendezvous service ships in the baseline. Public STUN and DHT are
not plugins or experiments: sending candidate addresses/timing to third-party
discovery networks violates the address-privacy invariant. A user may explicitly
designate a third-party-hosted anchor and accept that operator learning member
addresses, but it gains no data authority. This round-5 decision supersedes the
round-4 standalone-service resolution.

## Resolved decision: readable default engine backup (former Q11)

Former question 11 is resolved: the engine is a readable, default-on backup
subscriber for every logged-in account. It stores exactly the free or paid
partition and can serve recovery through its acknowledged frontier. It is not an
optional privacy mode, not blind ciphertext, and not a bridge or ordinary route.
It is a normal peer subscriber for replication and can acknowledge
partition-scoped replica safety/compaction; browsers never can. Anonymous mode
remains the explicit no-engine/no-backup choice. Provider secrets remain
excluded in every mode.

## Open product questions

1. **Offline grant/envelope lifetime.** Proposed default: owner/device
   certificate 90 days, write/execution grant 30 days, envelope no longer than
   the credential and at most 30 days; cached reads remain but writes stop. What
   shorter profiles/freshness should high-risk accounts require?
2. **Runner storage reserve.** Proposed default: admission needs current bytes
   plus 25%/absolute reserve, warning at 80%, and large-import pause before
   reserve. What projection and operator override ship?
3. **Blob limits/retention.** Every accepted blob reaches every ready runner and
   the entitled backup partition. What per-blob/account limits, compression, and
   tombstone retention balance local disk and paid engine cost?
4. **Credential targets.** Default all executor runners maximizes failover; an
   advanced exclusion warns. Which provider types default narrower?
5. **Credential recovery.** Ordinary readable backup deliberately excludes
   secrets. Should Q Mush offer passphrase/hardware-key user-held export, and
   how are forgotten keys/rotation communicated without engine escrow?
6. **LAN certificates.** Proposed loopback writes first; non-loopback writes
   need pinned HTTPS, with plain HTTP refused/read-only. Is read-only LAN HTTP
   worth the surface?
7. **Anchor recommendation and health.** Which setup wording and automated
   reachability tests best help a user choose a port-forwarded/mapped home
   runner or VPS without implying that an anchor is mandatory or always
   reachable? Optional third-party anchors must require explicit address-privacy
   consent.
8. **Unreachable executor recovery.** Default is recovery fork. Is a canonical
   takeover worth future fencing/quorum dependency despite arbitrary shell
   effects?
9. **Solid partial-view cache.** Proposed: cache recent/opened bounded views and
   selected blobs with clear `cached view` language; drafts can persist, but no
   shared outbox. What quotas/LRU/pinning best support offline reading without
   suggesting replica safety?
10. **Prompt conflicts.** Is simultaneous character editing important enough for
    an Automerge/Yjs spike beyond field-level HLC plus retained loser revisions?
11. **Former engine-backup privacy question — resolved.** The subscriber is
    default-on and readable for each logged-in tier, as recorded above.
12. **Future scoped device class.** If very large/team accounts need partial
    storage, should it be separately named and barred from runner safety quorum?
    It is outside #46 and needs new availability analysis.
13. **Multi-user collaboration.** Current data is user-owned. Should initial
    grants expose only owner roles or reserve future viewer/editor role codes?
14. **Regulated erasure.** Do hard-delete workflows require a separate epic with
    acknowledgement across runners and readable tier backups?
15. **Paid-to-free session backup retention.** Proposed policy: revoke session
    subscription/download immediately, quarantine prior paid session data for 30
    days to allow re-upgrade, then cryptographically purge session projections,
    operation/snapshot ranges, and unshared blobs. This balances accidental
    downgrade/payment recovery against finite operator cost and avoids
    indefinite surprise retention. Should voluntary downgrade purge immediately
    instead? How long should payment-failure grace last, what notices/exports
    are required, and what minimal content-free audit record may remain? This
    cannot permit new session ingestion for free or deletion from runners.
16. **OpenAI device-flow contract.** Before implementation, verify production
    endpoint/client/scopes/polling terms. If unavailable, API keys are the
    honest fallback; the engine loopback callback does not return as a fallback.
17. **Former DHT experiment — resolved/rejected.** There is no threshold or
    plugin experiment. Publishing a member's IP and timing to DHT strangers,
    including under opaque rotating keys, violates address privacy; the extra
    routing/abuse stack does not remove relay needs.
18. **Candidate lifetime and privacy.** Choose candidate expiry, signed-version
    conflict rules, keepalive bounds, stale-cache retention, and admission/
    manual-package expiry/erasure. Address material must remain inside encrypted
    member channels, an explicit user-designated anchor channel, the engine's
    documented tier channel, or explicit one-use packages; candidates must never
    derive or confer account authority.

Resolved choices—runner completeness, browser partial-view status, anonymous
use, readable tiered backup, private-mesh discovery and anchors, manual blackout
recovery, peer trust/provisioning, runner-side OpenAI and OpenRouter
authorization under current contracts, and peer-first transport—are absent from
discretionary selection. Changing one requires architecture re-acceptance.
