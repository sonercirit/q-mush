import { superviseRunner } from "./runner-supervisor.ts";

function requiredArgument(index: number, label: string): string {
  const value = process.argv[index];
  if (value === undefined || value.length === 0) {
    throw new Error(`The runner supervisor ${label} is invalid`);
  }
  return value;
}

try {
  await superviseRunner(
    requiredArgument(2, "executable path"),
    requiredArgument(3, "configuration path"),
  );
} catch (error) {
  console.error(
    "Q Mush runner supervisor stopped:",
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 1;
}
