import { chmod } from "node:fs/promises";

const pathname = process.argv[2];
const modulePath = process.argv[3];
if (pathname === undefined || modulePath === undefined) {
  throw new Error("Bun shim writer requires a path and module");
}
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

await Bun.write(
  pathname,
  `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(modulePath)} "$@"\n`,
);
await chmod(pathname, 0o755);
