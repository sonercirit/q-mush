import { chmod } from "node:fs/promises";

const pathname = process.argv[2];
const modulePath = process.argv[3];
if (pathname === undefined || modulePath === undefined) {
  throw new Error("Bun shim writer requires a path and module");
}
await Bun.write(
  pathname,
  `#!${process.execPath}\nawait import(${JSON.stringify(modulePath)});\n`,
);
await chmod(pathname, 0o755);
