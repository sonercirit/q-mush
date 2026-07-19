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
http://localhost:3000/api/auth/google/callback
```

Generate separate 32-byte keys for encrypted OpenAI and OpenRouter storage, then
copy the output into `.env.local`:

```bash
bun -e 'import { randomBytes } from "node:crypto"; for (const name of ["OPENAI_CREDENTIAL_KEY", "OPENROUTER_CREDENTIAL_KEY"]) console.log(`${name}=${randomBytes(32).toString("base64url")}`)'
```

Keep `.env.local` private; it is ignored by Git. Losing or changing either key
makes that provider's stored credentials unreadable. By default, local data is
stored in `data/q-mush.sqlite`; set `DATABASE_PATH` to use another SQLite file.
Set `GOOGLE_REDIRECT_URI` to the deployed HTTPS Google callback URL when running
on another origin.

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
bun run src/index.ts
```

To run the server in watch mode during development:

```bash
bun run dev
```

The server builds the browser entry and Tailwind stylesheet in memory at
startup, then exposes two pages and their assets:

- `/` renders the homepage to HTML on the server.
- `/app` serves an empty application shell, then `/app.js` renders the app in
  the browser.
- `/styles.css` serves the stylesheet shared by both pages.
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

The Google login flow uses an authorization code, PKCE, and a short-lived state
cookie. Only the basic Google profile and email scopes are requested. Google
tokens are discarded after profile lookup. Once logged in, a user can connect
multiple OpenAI or OpenRouter accounts through PKCE flows or add multiple
existing API keys for either provider. OpenAI OAuth represents Codex/ChatGPT
subscription access, while OpenAI Platform API keys use API billing. OpenAI keys
are validated with `/v1/me`, and OpenRouter keys are validated with its key
metadata endpoint. OpenAI OAuth access and refresh tokens and all provider API
keys are encrypted with AES-256-GCM in the local database; the API never returns
plaintext credentials to the browser. Removing a credential clears its encrypted
payload and retains a soft-deleted audit row. It does not revoke provider-side
access, so revoke the credential with its provider when it should no longer
exist there.

Drizzle stores users, seven-day application sessions, and provider credentials
in local SQLite, so they survive server restarts. Application primary keys use
UUIDv7; provider IDs, credential fingerprints, and cookie tokens remain separate
external identifiers. Every application row carries creation, update, actor, and
soft-deletion audit fields. Committed migrations in `drizzle/` are applied
automatically at startup.

Both pages use the small framework-free TSX runtime in `src/jsx.ts`; no frontend
framework is installed. `src/styles.css` is the Tailwind source entry point, and
no generated frontend assets are written to disk.

Apply pending migrations without starting the server:

```bash
bun run db:migrate
```

After changing `src/database/schema.ts`, generate and review a migration:

```bash
bun run db:generate
```

To run all static checks:

```bash
bun run check
```

The checks are also available separately as `bun run repository-check`,
`bun run format:check`, `bun run typecheck`, `bun run lint`, `bun run knip`, and
`bun run cpd`. The repository check requires every tracked or unignored file
except `bun.lock` and files in the generated `drizzle/` migration tree to stay
below 20,000 characters, and every JavaScript or TypeScript test file to be
inside a directory named `test` at any depth. The CPD check rejects JavaScript
or TypeScript clones of at least 20 tokens on one or more lines, including
clones across source extensions. Run `bun run format` to format files,
`bun run lint:fix` to apply safe lint fixes, and `bun test` to run the tests.

This project was created using `bun init` in bun v1.3.14. [Bun](https://bun.com)
is a fast all-in-one JavaScript runtime.
