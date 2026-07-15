# q-mush

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

To run all static checks:

```bash
bun run check
```

The checks are also available separately as `bun run file-length`, `bun run typecheck`,
`bun run lint`, and `bun run knip`. The file-length check requires every tracked or
unignored file except `bun.lock` to stay below 20,000 characters; when a file reaches
the limit, split or condense it. Run `bun run lint:fix` to apply safe lint fixes and
`bun test` to run the tests.

This project was created using `bun init` in bun v1.3.14. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
