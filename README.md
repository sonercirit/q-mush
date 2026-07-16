# Q Mush

The local-first distributed agent swarm harness.

To install dependencies:

```bash
bun install
```

To configure Google login, copy the environment template and fill in the web
OAuth client credentials from Google Cloud:

```bash
cp .env.example .env.local
```

Register this exact authorized redirect URI on the Google OAuth client:

```text
http://localhost:3000/api/auth/google/callback
```

Keep `.env.local` private; it is ignored by Git. Set `GOOGLE_REDIRECT_URI` to
the deployed HTTPS callback URL when running on another origin.

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

The login flow uses an authorization code, PKCE, and a short-lived state cookie.
Only the basic Google profile and email scopes are requested. Google tokens are
discarded after profile lookup; the resulting session is held in memory on the
local server and is cleared by a server restart.

Both pages use the small framework-free TSX runtime in `src/jsx.ts`; no frontend
framework is installed. `src/styles.css` is the Tailwind source entry point, and
no generated frontend assets are written to disk.

To run all static checks:

```bash
bun run check
```

The checks are also available separately as `bun run repository-check`,
`bun run format:check`, `bun run typecheck`, `bun run lint`, `bun run knip`, and
`bun run cpd`. The repository check requires every tracked or unignored file
except `bun.lock` to stay below 20,000 characters and every JavaScript or
TypeScript test file to be inside a directory named `test` at any depth. The CPD
check rejects JavaScript or TypeScript clones of at least 20 tokens on one or
more lines, including clones across source extensions. Run `bun run format` to
format files, `bun run lint:fix` to apply safe lint fixes, and `bun test` to run
the tests.

This project was created using `bun init` in bun v1.3.14. [Bun](https://bun.com)
is a fast all-in-one JavaScript runtime.
