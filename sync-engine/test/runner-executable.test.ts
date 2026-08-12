import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  RUNNER_EXECUTABLE_PATH,
  RUNNER_EXECUTABLE_SHA256_HEADER,
  RUNNER_SUPERVISOR_PATH,
} from "../../shared/routes.ts";
import { buildRunnerExecutableProvider } from "../../sync-engine/runner-executable.ts";
import {
  RUNNER_TARGETS,
  type RunnerExecutableTarget,
} from "../../sync-engine/runner-target.ts";

const RUNNER_VERSION = "c".repeat(64);
const TARGET = "bun-linux-x64-baseline";
const EXECUTABLE = new TextEncoder().encode("compiled runner executable");
const PAGE_FETCH_PROBE = fileURLToPath(
  new URL("../../runner/test/page-fetch-compiled-probe.ts", import.meta.url),
);

function localRunnerTarget(): RunnerExecutableTarget {
  if (process.platform === "darwin") {
    return process.arch === "arm64"
      ? RUNNER_TARGETS.darwinArm64
      : RUNNER_TARGETS.darwinX64;
  }

  if (process.platform !== "linux") {
    throw new Error(`Unsupported test platform: ${process.platform}`);
  }

  const ldd = Bun.spawnSync(["ldd", "--version"]);
  const description = `${new TextDecoder().decode(ldd.stdout)}${new TextDecoder().decode(ldd.stderr)}`;
  const usesMusl = description.toLowerCase().includes("musl");

  if (process.arch === "arm64") {
    return usesMusl ? RUNNER_TARGETS.linuxArm64Musl : RUNNER_TARGETS.linuxArm64;
  }

  return usesMusl ? RUNNER_TARGETS.linuxX64Musl : RUNNER_TARGETS.linuxX64;
}

function emptyExecutableProvider() {
  return buildRunnerExecutableProvider({
    build: () => Promise.resolve(new Blob()),
    version: RUNNER_VERSION,
  });
}

function removeTemporaryDirectory(directory: string): void {
  rmSync(directory, { force: true, recursive: true });
}

function executableRequest(
  target = TARGET,
  headers?: HeadersInit,
  method = "GET",
): Request {
  const url = new URL(RUNNER_EXECUTABLE_PATH, "http://localhost:3000");
  const init: RequestInit = { method };
  url.searchParams.set("target", target);

  if (headers !== undefined) {
    init.headers = headers;
  }

  return new Request(url, init);
}

describe("runner executable downloads", () => {
  test("serves a cached, checksummed standalone executable", async () => {
    let builds = 0;
    const provider = await buildRunnerExecutableProvider({
      build: (target) => {
        expect(target).toBe(TARGET);
        builds += 1;
        return Promise.resolve(new Blob([EXECUTABLE]));
      },
      version: RUNNER_VERSION,
    });

    const first = await provider.serve(executableRequest());
    const second = await provider.serve(executableRequest());
    const digest = createHash("sha256").update(EXECUTABLE).digest("hex");

    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toBe("application/octet-stream");
    expect(first.headers.get("cache-control")).toBe("no-cache");
    expect(first.headers.get("content-disposition")).toBe(
      'attachment; filename="q-mush-runner"',
    );
    expect(first.headers.get("etag")).toBe(`"${RUNNER_VERSION}"`);
    expect(first.headers.get(RUNNER_EXECUTABLE_SHA256_HEADER)).toBe(digest);
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(EXECUTABLE);
    expect(new Uint8Array(await second.arrayBuffer())).toEqual(EXECUTABLE);
    expect(builds).toBe(1);
  });

  test("serves a separately cached standalone supervisor", async () => {
    let supervisorBuilds = 0;
    const provider = await buildRunnerExecutableProvider({
      build: () => Promise.resolve(new Blob([EXECUTABLE])),
      buildSupervisor: (target) => {
        expect(target).toBe(TARGET);
        supervisorBuilds += 1;
        return Promise.resolve(new Blob(["compiled supervisor"]));
      },
      version: RUNNER_VERSION,
    });
    const supervisorRequest = new Request(
      `http://localhost:3000${RUNNER_SUPERVISOR_PATH}?target=${TARGET}`,
    );

    const first = await provider.serveSupervisor(supervisorRequest);
    const second = await provider.serveSupervisor(supervisorRequest);

    expect(await first.text()).toBe("compiled supervisor");
    expect(await second.text()).toBe("compiled supervisor");
    expect(supervisorBuilds).toBe(1);
  });

  test("returns not modified without building when the runner is current", async () => {
    const provider = await buildRunnerExecutableProvider({
      build: () => {
        throw new Error("A current runner must not trigger a build");
      },
      version: RUNNER_VERSION,
    });
    const response = await provider.serve(
      executableRequest(TARGET, { "if-none-match": `"${RUNNER_VERSION}"` }),
    );

    expect(response.status).toBe(304);
    expect(response.headers.get("etag")).toBe(`"${RUNNER_VERSION}"`);
    expect((await response.arrayBuffer()).byteLength).toBe(0);
  });

  test("rejects unsupported targets and methods", async () => {
    const provider = await emptyExecutableProvider();
    const unsupported = await provider.serve(
      executableRequest("bun-windows-x64"),
    );
    const wrongMethod = await provider.serve(
      executableRequest(TARGET, undefined, "POST"),
    );

    expect(unsupported.status).toBe(404);
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toBe("GET");
  });

  test("fetches a hostname inside the packaged Bun runtime", async () => {
    const compiler = await emptyExecutableProvider();
    const executable = await compiler.compile(
      localRunnerTarget(),
      PAGE_FETCH_PROBE,
    );
    const directory = mkdtempSync(join(tmpdir(), "q-mush-page-fetch-probe-"));
    const executablePath = join(directory, "page-fetch-probe");

    try {
      writeFileSync(executablePath, await executable.bytes(), { mode: 0o755 });
      const publicResult = Bun.spawnSync([
        executablePath,
        "fetch",
        "https://example.com/",
      ]);
      const unsafeResult = Bun.spawnSync([
        executablePath,
        "unsafe",
        "http://127.0.0.1/",
      ]);

      expect(publicResult.stderr.toString()).toBe("");
      expect(publicResult.exitCode).toBe(0);
      expect(publicResult.stdout.toString()).toBe("Example Domain\n");
      expect(unsafeResult.stderr.toString()).toBe("");
      expect(unsafeResult.exitCode).toBe(0);
      expect(unsafeResult.stdout.toString()).toBe("unsafe\n");
    } finally {
      removeTemporaryDirectory(directory);
    }
  }, 150_000);

  test("builds a runnable executable that does not need Bun on PATH", async () => {
    const provider = await buildRunnerExecutableProvider();
    const response = await provider.serve(
      executableRequest(localRunnerTarget()),
    );
    const directory = mkdtempSync(join(tmpdir(), "q-mush-runner-build-test-"));
    const executablePath = join(directory, "q-mush-runner");

    try {
      const executable = new Uint8Array(await response.arrayBuffer());
      writeFileSync(executablePath, executable);
      chmodSync(executablePath, 0o755);
      const runner = Bun.spawn([executablePath, "--version"], {
        env: { PATH: "" },
        stderr: "pipe",
        stdout: "pipe",
      });
      const standardErrorPromise = new Response(runner.stderr).text();
      const standardOutputPromise = new Response(runner.stdout).text();
      const exitCode = await runner.exited;

      expect(response.status).toBe(200);
      expect(executable.byteLength).toBeGreaterThan(1_000_000);
      expect(exitCode).toBe(0);
      expect(await standardErrorPromise).toBe("");
      expect(await standardOutputPromise).toBe(
        `Q Mush runner ${provider.version}\n`,
      );
    } finally {
      removeTemporaryDirectory(directory);
    }
  }, 120_000);
});
