import { createHash } from "node:crypto";
import * as fileSystem from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readBuildArtifact } from "./build.ts";
import { createMethodNotAllowedResponse } from "./http.ts";
import { RUNNER_EXECUTABLE_SHA256_HEADER } from "./routes.ts";
import {
  isRunnerExecutableTarget,
  type RunnerExecutableTarget,
} from "./runner-target.ts";

const RUNNER_ENTRYPOINT = fileURLToPath(
  new URL("runner-agent.ts", import.meta.url),
);
const RUNNER_VERSION_PATTERN = /^[a-f\d]{64}$/u;
const VERSION_GLOBAL = "Q_MUSH_RUNNER_VERSION";
const TARGET_GLOBAL = "Q_MUSH_RUNNER_TARGET";
const VERSION_PLACEHOLDER = "runner-version-placeholder";
const TARGET_PLACEHOLDER = "runner-target-placeholder";

interface RunnerExecutable {
  readonly body: Blob;
  readonly sha256: string;
}

type RunnerExecutableBuilder = (
  target: RunnerExecutableTarget,
) => Promise<Blob>;

interface RunnerExecutableBuildOptions {
  readonly build?: RunnerExecutableBuilder;
  readonly version?: string;
}

export interface RunnerExecutableProvider {
  readonly version: string;
  serve(request: Request): Promise<Response>;
}

function runnerBuildConfiguration(
  version: string,
  target: string,
): Bun.BuildConfig {
  return {
    define: {
      [TARGET_GLOBAL]: JSON.stringify(target),
      [VERSION_GLOBAL]: JSON.stringify(version),
    },
    entrypoints: [RUNNER_ENTRYPOINT],
    format: "esm",
    minify: true,
    target: "bun",
    throw: false,
  };
}

async function bundleRunnerSource(): Promise<Bun.BuildArtifact> {
  const result = await Bun.build(
    runnerBuildConfiguration(VERSION_PLACEHOLDER, TARGET_PLACEHOLDER),
  );
  return readBuildArtifact("runner source", result);
}

async function compileRunnerExecutable(
  target: RunnerExecutableTarget,
  version: string,
): Promise<Blob> {
  const directory = await fileSystem.mkdtemp(
    join(tmpdir(), "q-mush-runner-build-"),
  );
  const executablePath = join(directory, "q-mush-runner");

  try {
    const result = await Bun.build({
      ...runnerBuildConfiguration(version, target),
      compile: {
        autoloadBunfig: false,
        autoloadDotenv: false,
        autoloadPackageJson: false,
        autoloadTsconfig: false,
        outfile: executablePath,
        target,
      },
    });
    readBuildArtifact(`${target} runner executable`, result);

    const executable = await Bun.file(executablePath).arrayBuffer();

    if (executable.byteLength < 1_000_000) {
      throw new Error(
        `The ${target} runner build did not produce an executable`,
      );
    }

    return new Blob([executable]);
  } finally {
    await fileSystem.rm(directory, { recursive: true });
  }
}

async function runnerVersion(): Promise<string> {
  const source = await bundleRunnerSource();
  return createHash("sha256")
    .update("q-mush-standalone-runner-v1\0")
    .update(Bun.version)
    .update("\0")
    .update(Bun.revision)
    .update("\0")
    .update(new Uint8Array(await source.arrayBuffer()))
    .digest("hex");
}

function entityTag(version: string): string {
  return `"${version}"`;
}

function acceptsEntityTag(request: Request, tag: string): boolean {
  return (
    request.headers
      .get("if-none-match")
      ?.split(",")
      .some(
        (candidate) => candidate.trim() === tag || candidate.trim() === "*",
      ) ?? false
  );
}

class LazyRunnerExecutableProvider implements RunnerExecutableProvider {
  readonly #build: RunnerExecutableBuilder;
  readonly #executables = new Map<
    RunnerExecutableTarget,
    Promise<RunnerExecutable>
  >();
  readonly version: string;

  constructor(version: string, build: RunnerExecutableBuilder) {
    if (!RUNNER_VERSION_PATTERN.test(version)) {
      throw new Error("The runner version must be a SHA-256 digest");
    }

    this.version = version;
    this.#build = build;
  }

  async serve(request: Request): Promise<Response> {
    return request.method === "GET"
      ? this.#serveDownload(request)
      : createMethodNotAllowedResponse("GET");
  }

  async #serveDownload(request: Request): Promise<Response> {
    const targetValue = new URL(request.url).searchParams.get("target");

    if (targetValue === null || !isRunnerExecutableTarget(targetValue)) {
      return new Response("Not found", { status: 404 });
    }

    const tag = entityTag(this.version);
    const cacheHeaders = new Headers({
      "cache-control": "no-cache",
      etag: tag,
    });

    if (acceptsEntityTag(request, tag)) {
      return new Response(null, { headers: cacheHeaders, status: 304 });
    }

    try {
      const executable = await this.#load(targetValue);
      cacheHeaders.set(
        "content-disposition",
        'attachment; filename="q-mush-runner"',
      );
      cacheHeaders.set("content-length", String(executable.body.size));
      cacheHeaders.set("content-type", "application/octet-stream");
      cacheHeaders.set(RUNNER_EXECUTABLE_SHA256_HEADER, executable.sha256);
      cacheHeaders.set("x-content-type-options", "nosniff");
      return new Response(executable.body, { headers: cacheHeaders });
    } catch (error) {
      console.error("Runner executable build failed", error);
      return new Response("Runner executable unavailable", {
        headers: { "cache-control": "no-store" },
        status: 503,
      });
    }
  }

  #load(target: RunnerExecutableTarget): Promise<RunnerExecutable> {
    const existing = this.#executables.get(target);

    if (existing !== undefined) {
      return existing;
    }

    const pending = Promise.resolve()
      .then(() => this.#build(target))
      .then(async (body) => ({
        body,
        sha256: createHash("sha256")
          .update(new Uint8Array(await body.arrayBuffer()))
          .digest("hex"),
      }));
    this.#executables.set(target, pending);
    void pending.catch(() => {
      if (this.#executables.get(target) === pending) {
        this.#executables.delete(target);
      }
    });
    return pending;
  }
}

export async function buildRunnerExecutableProvider(
  options: RunnerExecutableBuildOptions = {},
): Promise<RunnerExecutableProvider> {
  const version = options.version ?? (await runnerVersion());
  const build =
    options.build ??
    ((target: RunnerExecutableTarget) =>
      compileRunnerExecutable(target, version));
  return new LazyRunnerExecutableProvider(version, build);
}
