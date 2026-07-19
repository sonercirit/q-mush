import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fileSystem from "node:fs";
import * as operatingSystem from "node:os";
import { join } from "node:path";
import {
  RUNNER_EXECUTABLE_PATH,
  RUNNER_EXECUTABLE_SHA256_HEADER,
} from "../routes.ts";
import { buildRunnerExecutableProvider } from "../runner-executable.ts";
import {
  RUNNER_TARGETS,
  type RunnerExecutableTarget,
} from "../runner-target.ts";

const RUNNER_VERSION = "c".repeat(64);
const TARGET = "bun-linux-x64-baseline";
const EXECUTABLE = new TextEncoder().encode("compiled runner executable");

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
    expect(await response.arrayBuffer()).toHaveLength(0);
  });

  test("rejects unsupported targets and methods", async () => {
    const provider = await buildRunnerExecutableProvider({
      build: () => Promise.resolve(new Blob()),
      version: RUNNER_VERSION,
    });
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

  test("builds a runnable executable that does not need Bun on PATH", async () => {
    const provider = await buildRunnerExecutableProvider();
    const response = await provider.serve(
      executableRequest(localRunnerTarget()),
    );
    const directory = fileSystem.mkdtempSync(
      join(operatingSystem.tmpdir(), "q-mush-runner-build-test-"),
    );
    const executablePath = join(directory, "q-mush-runner");

    try {
      const executable = new Uint8Array(await response.arrayBuffer());
      fileSystem.writeFileSync(executablePath, executable);
      fileSystem.chmodSync(executablePath, 0o755);
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
      fileSystem.rmSync(directory, { force: true, recursive: true });
    }
  }, 120_000);
});
