import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { updateRunnerIfAvailable } from "../../runner/runner-update.ts";
import { RUNNER_EXECUTABLE_SHA256_HEADER } from "../../shared/routes.ts";

const CURRENT_VERSION = "a".repeat(64);
const NEXT_VERSION = "b".repeat(64);
const RUNNER_TARGET = "bun-linux-x64-baseline";
const UPDATED_EXECUTABLE = new TextEncoder().encode("standalone executable");
const fixtureDirectories = new Set<string>();

interface UpdateFixture {
  readonly configurationPath: string;
  readonly executablePath: string;
}

function createFixture(): UpdateFixture {
  const directory = mkdtempSync(join(tmpdir(), "q-mush-runner-update-"));
  const executablePath = join(directory, "q-mush-runner");
  const configurationPath = join(directory, "config");
  fixtureDirectories.add(directory);
  writeFileSync(executablePath, "old executable", { mode: 0o755 });
  writeFileSync(configurationPath, "configuration");
  return { configurationPath, executablePath };
}

function installedExecutable(fixture: UpdateFixture): string {
  return readFileSync(fixture.executablePath, "utf8");
}

function unexpectedLaunch(message: string): () => never {
  return () => {
    throw new Error(message);
  };
}

function removeFixtures(): void {
  for (const directory of fixtureDirectories) {
    rmSync(directory, { force: true, recursive: true });
  }

  fixtureDirectories.clear();
}

afterEach(removeFixtures);

function updateContext(fixture: UpdateFixture) {
  return {
    configurationPath: fixture.configurationPath,
    executablePath: fixture.executablePath,
    serverOrigin: "http://localhost:3000",
    target: RUNNER_TARGET,
    version: CURRENT_VERSION,
  };
}

function updateResponse(
  body: Uint8Array<ArrayBuffer> = UPDATED_EXECUTABLE,
): Response {
  const digest = new Bun.CryptoHasher("sha256")
    .update(UPDATED_EXECUTABLE)
    .digest("hex");
  return new Response(new Blob([body]), {
    headers: {
      etag: `"${NEXT_VERSION}"`,
      [RUNNER_EXECUTABLE_SHA256_HEADER]: digest,
    },
  });
}

test("atomically installs and launches an available runner update", async () => {
  const fixture = createFixture();
  const operations: string[] = [];
  let launched:
    | { readonly arguments: readonly string[]; readonly path: string }
    | undefined;
  const updated = await updateRunnerIfAvailable(updateContext(fixture), {
    beforeRestart: () => {
      operations.push("handoff");
      expect(installedExecutable(fixture)).toBe("old executable");
      return Promise.resolve();
    },
    fetch: (request) => {
      expect(request.url).toBe(
        `http://localhost:3000/runner/executable?target=${RUNNER_TARGET}`,
      );
      expect(request.headers.get("if-none-match")).toBe(`"${CURRENT_VERSION}"`);
      return Promise.resolve(updateResponse());
    },
    launch: (path, arguments_) => {
      operations.push("launch");
      launched = { arguments: arguments_, path };
    },
  });

  expect(updated).toBe(true);
  expect(operations).toEqual(["handoff", "launch"]);
  expect(new Uint8Array(readFileSync(fixture.executablePath))).toEqual(
    UPDATED_EXECUTABLE,
  );
  expect(statSync(fixture.executablePath).mode & 0o777).toBe(0o755);
  expect(launched).toEqual({
    arguments: ["--config", fixture.configurationPath],
    path: fixture.executablePath,
  });
});

test("keeps running when the server reports that the runner is current", async () => {
  const fixture = createFixture();
  const updated = await updateRunnerIfAvailable(updateContext(fixture), {
    fetch: () => Promise.resolve(new Response(null, { status: 304 })),
    launch: unexpectedLaunch("A current runner must not restart"),
  });

  expect(updated).toBe(false);
  expect(readFileSync(fixture.executablePath, "utf8")).toBe("old executable");
});

test("does not install or launch when the restart handoff fails", async () => {
  const fixture = createFixture();

  await expect(
    updateRunnerIfAvailable(updateContext(fixture), {
      beforeRestart: () => Promise.reject(new Error("handoff failed")),
      fetch: () => Promise.resolve(updateResponse()),
      launch: unexpectedLaunch("A failed handoff must not launch"),
    }),
  ).rejects.toThrow("handoff failed");
  expect(statSync(fixture.executablePath).size).toBe("old executable".length);
});

test("rejects an update whose checksum does not match", async () => {
  const fixture = createFixture();
  let failure: unknown;

  try {
    await updateRunnerIfAvailable(updateContext(fixture), {
      fetch: () => Promise.resolve(updateResponse(new Uint8Array([1, 2, 3]))),
      launch: unexpectedLaunch("An invalid update must not launch"),
    });
  } catch (error) {
    failure = error;
  }

  if (!(failure instanceof Error)) {
    throw new Error("The invalid runner update did not fail");
  }

  expect(failure.message).toContain("checksum");
  expect(installedExecutable(fixture)).toBe("old executable");
});
