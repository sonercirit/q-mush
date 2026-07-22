import { ESLint } from "eslint";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";

const ROOT_DIRECTORY = join(import.meta.dirname, "../..");
const PROBES = {
  rootScripts: join(ROOT_DIRECTORY, "boundary-root-scripts-probe.ts"),
  runner: join(ROOT_DIRECTORY, "runner", "test", "boundary-probe.ts"),
  scripts: join(ROOT_DIRECTORY, "scripts", "test", "boundary-probe.ts"),
  shared: join(ROOT_DIRECTORY, "shared", "test", "boundary-probe.ts"),
  solid: join(ROOT_DIRECTORY, "solid", "test", "boundary-probe.ts"),
  syncEngine: join(ROOT_DIRECTORY, "sync-engine", "test", "boundary-probe.ts"),
  syncEngineRoot: join(
    ROOT_DIRECTORY,
    "sync-engine",
    "test",
    "boundary-root-probe.ts",
  ),
  syncEngineShared: join(
    ROOT_DIRECTORY,
    "sync-engine",
    "test",
    "boundary-shared-probe.ts",
  ),
} as const;

async function lintProbe(path: string, source: string): Promise<string[]> {
  await writeFile(path, source);
  const [result] = await new ESLint().lintFiles([path]);
  return (result?.messages ?? []).map(({ message }) => message);
}

test("enforces workspace import boundaries", async () => {
  await Promise.all(
    Object.values(PROBES).map((probe) =>
      mkdir(join(probe, ".."), { recursive: true }),
    ),
  );

  try {
    const [
      rootScripts,
      runner,
      scripts,
      shared,
      solid,
      syncEngine,
      syncEngineRoot,
      syncEngineShared,
    ] = await Promise.all([
      lintProbe(
        PROBES.rootScripts,
        'import { findFileLengthViolations } from "./scripts/check-file-length.ts";\nconsole.log(findFileLengthViolations);\n',
      ),
      lintProbe(
        PROBES.runner,
        'import { solidProbe } from "../../solid/test/boundary-probe.ts";\nconsole.log(solidProbe);\n',
      ),
      lintProbe(
        PROBES.scripts,
        'import { runnerProbe } from "../../runner/test/boundary-probe.ts";\nconsole.log(runnerProbe);\n',
      ),
      lintProbe(
        PROBES.shared,
        'import { syncEngineProbe } from "../../sync-engine/test/boundary-probe.ts";\nconsole.log(syncEngineProbe);\n',
      ),
      lintProbe(
        PROBES.solid,
        'import { scriptProbe } from "../../scripts/test/boundary-probe.ts";\nconsole.log(scriptProbe);\n',
      ),
      lintProbe(
        PROBES.syncEngine,
        'import { runnerProbe } from "../../runner/test/boundary-probe.ts";\nconsole.log(runnerProbe);\n',
      ),
      lintProbe(
        PROBES.syncEngineRoot,
        'export * from "../../vite.config.ts";\n',
      ),
      lintProbe(
        PROBES.syncEngineShared,
        'export * from "../../shared/routes.ts";\n',
      ),
    ]);

    for (const messages of [runner, shared, syncEngine, syncEngineRoot]) {
      expect(messages).toContain(
        "Import only within this workspace or from shared.",
      );
    }
    expect(syncEngineShared).not.toContain(
      "Import only within this workspace or from shared.",
    );
    expect(rootScripts).toContain(
      "Importing from scripts is forbidden outside scripts.",
    );
    expect(solid).toContain(
      "Importing from scripts is forbidden outside scripts.",
    );
    expect(scripts).not.toContain(
      "Importing from scripts is forbidden outside scripts.",
    );
  } finally {
    await Promise.all(
      Object.values(PROBES).map((probe) => rm(probe, { force: true })),
    );
  }
});
