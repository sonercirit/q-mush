# Q Mush

The local-first distributed agent swarm harness.

To install dependencies:

```bash
bun install
```

To configure local storage, Google login, and encrypted provider credentials,
copy the environment template and fill in the web OAuth client credentials from
Google Cloud:

```bash
cp .env.example .env.local
```

Register this exact authorized redirect URI on the Google OAuth client:

```text
http://localhost:12345/api/auth/google/callback
```

Generate separate 32-byte keys for encrypted OpenAI, OpenRouter, generic LLM,
and Brave Search credential storage, then copy the output into `.env.local`:

```bash
bun -e 'import { randomBytes } from "node:crypto"; for (const name of ["OPENAI_CREDENTIAL_KEY", "OPENROUTER_CREDENTIAL_KEY", "GENERIC_CREDENTIAL_KEY", "BRAVE_SEARCH_CREDENTIAL_KEY"]) console.log(`${name}=${randomBytes(32).toString("base64url")}`)'
```

Keep `.env.local` private; it is ignored by Git. Losing or changing a credential
encryption key makes that integration's stored credentials unreadable. By
default, local data is stored in `data/q-mush.sqlite`; set `DATABASE_PATH` to
use another SQLite file. Set `GOOGLE_REDIRECT_URI` to the deployed HTTPS Google
callback URL when running on another origin.

OpenAI account connection uses the Codex authorization-code flow. With its
public client ID, Q Mush listens on the registered
`http://localhost:1455/auth/callback` loopback URL and returns the browser to
the main app; keep port 1455 available. A deployment with another public OAuth
client can set `OPENAI_CLIENT_ID` and its registered `OPENAI_REDIRECT_URI`,
which must end in `/api/openai/oauth/callback`. OpenRouter supports localhost
callbacks without app credentials. Its callback defaults to the current origin;
set `OPENROUTER_REDIRECT_URI` to the deployed HTTPS URL ending in
`/api/openrouter/oauth/callback` when needed.

To run:

```bash
bun run sync-engine/index.ts
```

To run the supervised development server:

```bash
bun run dev
```

Both commands serve Q Mush at `http://localhost:12345` by default. Set `PORT` to
override the listening port, and update OAuth callback URLs and registrations to
match.

To also watch source and local environment edits, run `bun run dev:watch`
instead of `bun run dev`. Changes under `runner/`, `shared/`, `solid/`, or
`sync-engine/`, plus `.env`, `.env.local`, and root build/configuration source,
are coalesced before requesting one graceful restart. Generated output,
dependencies, tests, local data, VCS internals, and editor temporary files are
ignored. To request the same restart explicitly:

```bash
bun run dev:restart
```

A restart closes admission for new work, lets each in-flight agent step reach
completion, and then rebuilds the browser assets and runner version. No
additional step starts on the draining process; work submitted during the drain
remains durably queued and launches after the new process starts. Connected
runners observe that version on their next API response and immediately check
for a changed executable. A session can therefore request the restart that will
apply its own changes without being marked failed.

Production source is split into four top-level workspaces: `solid/` owns the
browser UI, `sync-engine/` owns the Bun server and synchronization/model
integrations, `runner/` owns the standalone runner, and `shared/` owns code used
across those boundaries. Each of the first three may import only itself and
`shared`; `shared` cannot import another workspace. Application code outside
`scripts/` also cannot import script internals. ESLint enforces these rules.
Tests and support modules are colocated under `solid/test/`,
`sync-engine/test/`, `runner/test/`, `shared/test/`, and `scripts/test/`;
cross-workspace integration tests belong to `sync-engine/test/`. The former
`src/` tree has been removed.

The server builds the SolidJS browser app and Tailwind stylesheet with Vite in
memory at startup and prepares versioned standalone runner builds, then exposes
two pages and their assets:

- `/` renders the homepage to HTML on the server.
- `/app` serves an empty application shell, then `/app.js` renders the app in
  the browser.
- `/styles.css` serves the stylesheet shared by both pages.
- `/runner/install.sh` serves token-scoped macOS and Linux installers, while
  `/runner/executable` builds and caches the requested standalone runner
  executable.
- `/api` is the base path for APIs. `/api/auth/google` starts Google OpenID
  Connect login and `/api/auth/google/callback` completes it.
- `/api/auth/session` returns the local session, while `POST /api/auth/logout`
  clears it.
- Authenticated users manage OpenAI access through `/api/openai/credentials`.
  `/api/openai/oauth` connects an account. The default Codex callback arrives on
  the loopback listener; `/api/openai/oauth/callback` supports a configured
  OAuth client callback.
- Authenticated users manage OpenRouter access through
  `/api/openrouter/credentials`. `/api/openrouter/oauth` connects an account and
  `/api/openrouter/oauth/callback` completes the flow.
- Authenticated users add OpenAI-compatible API base URLs and optional API keys
  through `/api/generic/credentials`.
- Authenticated users add and remove Brave Search API keys through
  `/api/skills/brave-search/keys`. These keys power the server-side
  `brave_search` agent skill.
- Authenticated users list and create runner setups at `/api/runners`, remove
  one at `/api/runners/:id`, and browse an online runner through
  `POST /api/runners/:id/directories`. Installed runners register, report
  presence, receive work, return results, and accept cancellation through the
  authenticated `/api/runner/realtime` WebSocket. The browser receives runner
  and session snapshots, tool-limit settings, plus streaming model output
  through authenticated `/api/realtime` WebSockets.
- Users manage limits at `/api/tool-settings`.
- Authenticated users create and list agent sessions at `/api/sessions`,
  discover models for an owned credential at `/api/sessions/models`, inspect
  `/api/sessions/:id`, send follow-ups to `/api/sessions/:id/messages`, compact
  history through `/api/sessions/:id/compact`, toggle automatic compaction at
  `/api/sessions/:id/compaction`, reassign a session after runner removal with
  `POST /api/sessions/:id/reassign`, and stop work through
  `/api/sessions/:id/stop`. Reassignment requires an owned online runner and an
  explicit working directory on that computer; it changes the assignment but
  never starts the session automatically.

After signing in, use **Set up a runner** in the control center. Run the shown
one-liner on a macOS or Linux computer, or download and run the installer. The
installer detects macOS or Linux, x64 or ARM64, and glibc or musl where
applicable. It downloads one self-contained executable under `~/.q-mush/runner`
(override with `Q_MUSH_RUNNER_HOME`) and starts one background process. Bun does
not need to be installed on the runner computer. The setup command contains a
private token that connects that computer to the signed-in user, so do not share
it. To install on another computer, create another setup; users can add as many
runners as needed.

The install command uses the origin from which the control center was opened.
For another computer to connect, open Q Mush through an address that computer
can reach instead of `localhost`. A runner derives an opaque machine fingerprint
and the database allows only one active runner for a computer. It reports its
hostname, platform, architecture, and a heartbeat every 15 seconds over its
WebSocket; the control center receives live presence without exposing its token.
The runner checks for a versioned update at startup and every five minutes. The
WebSocket handshake advertises the current version, so a runner checks
immediately after contacting a restarted server. It verifies the executable's
SHA-256 digest, atomically replaces itself, and restarts. An offline runner
retains its session assignments. Removing a runner revokes its server-side
registration, marks its non-stopped sessions as requiring replacement, but does
not delete files from that computer. Rerun the installer once to migrate a
legacy `q-mush-runner.js` installation to the self-updating executable. A
removed registration is not reused: reinstalling that computer creates a new
runner ID, and affected sessions must be reassigned explicitly.

The control center supports phone through wide desktop viewports. Session detail
includes an app focus mode (separate from browser Fullscreen) that fills the app
viewport while retaining a compact session rail; hover or keyboard focus expands
the rail on desktop, while touch-sized layouts use the **Sessions** drawer.
Selecting a session collapses it, and Escape closes the drawer before leaving
focus mode. Focus mode keeps the mounted transcript, draft inputs, and
scroll-lock state intact.

After a runner and provider credential are ready, use **New agent session** in
the control center. Select an online computer and credential; Q Mush discovers
that credential's available agent models and explicitly reported reasoning
efforts. Reasoning effort defaults to the maximum reported for the model. Then
select the model, working directory, and task. Tasks and follow-up messages can
select or paste up to eight PNG, JPEG, GIF, or WebP images of 10 MB each;
attachments are persisted in the transcript and sent directly to the selected
model provider. The working-directory field accepts a path or opens
Home/Up/child navigation; choosing a location writes its canonical path to the
form. Q Mush owns its model/tool loop. Before each initial or follow-up agent
run, the runner loads `AGENTS.md` from the selected working directory, falling
back to `CLAUDE.md`; when both exist, only `AGENTS.md` is used, and when neither
exists, no project instructions are added. The chosen file persists with the
session, joins the system prompt, and shows in the transcript. Per-user tool
settings default to 30 minutes and 20,000 Unicode characters per result. The
picker and prompt show them once; each run snapshots them, so changes apply next
run. One deadline covers runner, session, skill, discovery, directory, parallel,
and sleep work; `ask_questions` waits outside it and shell timeouts may be
shorter. One Unicode boundary adds one truncation notice; pagination and
input/security/transport limits remain separate. Q Mush exposes Pi's four base
tool interfaces—`read`, `bash`, `edit`, and `write`—plus a `parallel` wrapper
for 2+ independent calls and the server-side `brave_search` skill for current
web results, with batched exact edits. `parallel` has no application-defined
call maximum: a small worker pool bounds simultaneous execution while every
accepted call runs and results keep input order. Each tool/skill has accessible
authoritative details and its schema. Brave Search tries the signed-in user's
saved keys in order when a key is rejected, rate limited, or temporarily
unavailable. Transcripts show system instructions, complete tool definitions,
reasoning summaries, tool calls, and tool results. Transcript prose renders as
Markdown, fenced code is syntax-colored, and structured tool arguments/results
are pretty-printed with colorized JSON. The session-tool group lets an agent
list only its owner's online runners, inspect `runnerRequired` in session lists,
browse canonical runner directories from `~`, and explicitly reassign another
recoverable session. These tools never return runner tokens or other secrets,
and reassignment does not continue or launch the target session. Context use
includes a percentage, turns yellow at 80%, and red at 90%. The session list and
transcript header also show cumulative active runtime across all runs plus
cumulative model cost. A provider-reported charge is shown as **Cost**;
otherwise Q Mush shows **Estimated cost** only when detailed token usage and
provider-discovered pricing cover every consumed token category. Q Mush has no
built-in model-price table and shows unavailable rather than guessing a missing
price. Automatic compaction is enabled per session by default and replaces
completed history with a model-generated handoff once usage reaches 95%, then
transparently continues the active session from that summary. Automatic and
manual compaction model calls count toward cumulative cost. It can be turned
off, and a ready session can be compacted manually without continuing it.
**Ready** is continuable `idle`; each spawned final response reports once.
**Completed** marks terminal success; waiting for answers and idle attempts
without a final response are non-final. Transcripts/status survive reloads;
ready, stopped, or failed sessions accept follow-up instructions. When an
assigned runner is removed, the session shows **Choose runner** instead of
**Failed**, keeps its transcript and configuration, and disables follow-up,
continue, image, and compaction controls until an online replacement and a
confirmed working directory are chosen. Reassignment does not resume work.
**Stop session** aborts the model request and cancels an active runner command.

The runner executes file tools and bare-metal shells with the runner process's
local account permissions. In bare-metal sessions file tools accept any path
that account can access, resolving relative paths against the selected
workspace; shell commands are intentionally full commands rooted in that
directory. Container sessions confine file tools to the mounted workspace;
shells run as container root with network access. Rootful container root is host
root over the mount and can leave dangerous root-owned files, so trust container
sessions like the workspace; rootless Podman maps files to the runner account.
The default `archlinux:latest` image is amd64-only; unless the runtime runs
amd64 (native or configured emulation) set `Q_MUSH_CONTAINER_IMAGE`
(`Q_MUSH_CONTAINER_RUNTIME` selects docker or podman). The directory browser
returns the canonical location, parent, and up to 500 readable child
directories. Only use runners and credentials you trust with the project; the
agent file goes to the model as project instructions. Provider secrets remain on
the Q Mush server: the browser and runner work protocol never receive them.

OpenAI API keys and connected accounts prefer the streaming Responses WebSocket
and fall back to HTTP streaming when that transport is unavailable. OpenRouter
credentials use its streaming chat-completions API. Generic credentials use the
configured OpenAI-compatible `/chat/completions` HTTP stream, and model
discovery uses `/models` beneath the same API base URL. API keys are optional so
local keyless endpoints work. OpenAI connected accounts use the
subscription-backed Codex Responses endpoint; Q Mush refreshes and re-encrypts
expiring OAuth tokens. Model discovery queries the Codex account catalog, OpenAI
`/v1/models`, OpenRouter `/api/v1/models/user`, or the generic provider's
configured `/models` endpoint with the selected server-side credential. Codex
and OpenRouter publish reasoning metadata, so their effort select contains only
efforts explicitly enumerated for the model. Generic model metadata is used only
when the endpoint explicitly returns it; missing capabilities remain unknown.
OpenAI's standard models endpoint only publishes model availability, so API-key
models use their provider default setting. A selected effort is sent using each
provider's native request shape. Before a model step is persisted or any
requested tool runs, Q Mush retries transient network failures, retryable HTTP
statuses, accepted streams that disconnect or end early, and transient provider
error events with bounded exponential backoff. Partial live output is cleared
before replay so it is neither duplicated nor persisted; permanent provider
errors and stopped sessions do not retry. `Retry-After` is honored when
available. The first-party loop passes explicit function calls to the runner and
feeds bounded results back to the selected model.

The Google login flow uses an authorization code, PKCE, and a short-lived state
cookie. Only the basic Google profile and email scopes are requested. Google
tokens are discarded after profile lookup. Once logged in, a user can connect
multiple OpenAI or OpenRouter accounts through PKCE flows, add multiple existing
API keys for either provider, and register multiple generic OpenAI-compatible
endpoints. OpenAI OAuth represents Codex/ChatGPT subscription access, while
OpenAI Platform API keys use API billing. OpenAI keys are validated with
`/v1/me`, and OpenRouter keys are validated with its key metadata endpoint.
OpenAI OAuth access and refresh tokens, provider API keys (including optional
generic-provider keys), and Brave Search API keys are encrypted with AES-256-GCM
in the local database; the API never returns plaintext credentials to the
browser. Removing a credential clears its encrypted payload and retains a
soft-deleted audit row. It does not revoke provider-side access, so revoke the
credential with its provider when it should no longer exist there.

Drizzle stores users, seven-day application sessions, provider and skill
credentials, runner registrations, agent sessions, and agent transcripts in
local SQLite, so they survive server restarts. Graceful development restarts
finish active steps and preserve queued work for the replacement process;
sessions interrupted by an unexpected process exit are marked failed and can be
continued from the control center. Application primary keys use UUIDv7; provider
IDs, credential fingerprints, runner token hashes, machine fingerprints, and
cookie tokens remain separate external identifiers. Plaintext runner tokens
appear only in setup artifacts and the installed computer's private config.
Every application row carries creation, update, actor, and soft-deletion audit
fields. Committed migrations in `drizzle/` are applied automatically at startup.

The UI in `solid/` uses SolidJS throughout. Vite and its Tailwind plugin build
`solid/client.tsx` and `solid/styles.css`; the server invokes that build in
memory at startup, while `bun run build` can emit the same assets to `dist/`.
`solid/pages.tsx` renders the server-owned page shells with Solid's SSR runtime;
`sync-engine/pages.ts` loads that TSX through Vite's SSR runner at startup.
Runner cross-compilation uses a temporary directory, then keeps each requested
platform executable in server memory.

Apply pending migrations without starting the server:

```bash
bun run db:migrate
```

After changing `shared/database/schema.ts`, generate and review a migration:

```bash
bun run db:generate
```

To run all static checks (every subcheck runs even if an earlier one fails):

```bash
bun run check
```

The checks are also available separately as `bun run repository-check`,
`bun run format:check`, `bun run typecheck`, `bun run lint`, `bun run knip`, and
`bun run cpd`. The repository check requires every tracked or unignored file
except `bun.lock` and files in the generated `drizzle/` migration tree to stay
below 20,000 characters, and every JavaScript or TypeScript test file to be
inside a directory named `test` at any depth. It also rejects application
`.htm`, `.html`, and `.xhtml` files outside test and fixture directories. ESLint
rejects direct HTML-like `Response` bodies and unsafe DOM HTML injection APIs in
all first-party source and tests, while allowing HTML-like data and TSX. Both
checks recommend TSX for application markup. The CPD check ignores import
declarations and rejects other JavaScript or TypeScript clones of at least 20
tokens on one or more lines, including clones across source extensions. Run
`bun run format` to format files, `bun run lint:fix` to apply safe lint fixes,
and `bun run test` to run Vitest under Bun.

This project was created using `bun init` in bun v1.3.14. [Bun](https://bun.com)
is a fast all-in-one JavaScript runtime.
