import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RUNNER_EXECUTABLE_SHA256_HEADER } from "../shared/routes.ts";
import { readBuildArtifact } from "./build.ts";
import { buildClientRelease } from "./client-assets.ts";
import { createMethodNotAllowedResponse } from "./http.ts";
import {
  isRunnerExecutableTarget,
  type RunnerExecutableTarget,
} from "./runner-target.ts";

const RUNNER_ENTRYPOINT = fileURLToPath(
  new URL("../runner/runner-agent.ts", import.meta.url),
);
const RUNNER_SUPERVISOR_ENTRYPOINT = fileURLToPath(
  new URL("../runner/runner-supervisor-agent.ts", import.meta.url),
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

interface RunnerExecutableSource {
  readonly build: RunnerExecutableBuilder;
  readonly cache: Map<RunnerExecutableTarget, Promise<RunnerExecutable>>;
}

interface RunnerExecutableBuildOptions {
  readonly build?: RunnerExecutableBuilder;
  readonly buildSupervisor?: RunnerExecutableBuilder;
  readonly version?: string;
}

export interface RunnerExecutableProvider {
  readonly version: string;
  /** @internal Compiles an alternate entrypoint with the production runner settings. */
  compile(target: RunnerExecutableTarget, entrypoint: string): Promise<Blob>;
  serve(request: Request): Promise<Response>;
  serveSupervisor(request: Request): Promise<Response>;
}

function runnerBuildConfiguration(
  version: string,
  target: string,
  entrypoint = RUNNER_ENTRYPOINT,
): Bun.BuildConfig {
  return {
    define: {
      [TARGET_GLOBAL]: JSON.stringify(target),
      [VERSION_GLOBAL]: JSON.stringify(version),
    },
    entrypoints: [entrypoint],
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

async function compileStandaloneExecutable(
  target: RunnerExecutableTarget,
  version: string,
  entrypoint = RUNNER_ENTRYPOINT,
): Promise<Blob> {
  const directory = await mkdtemp(join(tmpdir(), "q-mush-runner-build-"));
  const executablePath = join(directory, "q-mush-runner");

  try {
    const result = await Bun.build({
      ...runnerBuildConfiguration(version, target, entrypoint),
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
    await rm(directory, { recursive: true });
  }
}

async function runnerVersion(): Promise<string> {
  const source = await bundleRunnerSource();
  const clientRelease = await buildClientRelease();
  const releaseManifest = clientRelease.files["manifest.json"];
  if (releaseManifest === undefined) {
    throw new Error("The browser release manifest is missing");
  }
  return createHash("sha256")
    .update("q-mush-standalone-runner-v1\0")
    .update(Bun.version)
    .update("\0")
    .update(Bun.revision)
    .update("\0")
    .update(new Uint8Array(await source.arrayBuffer()))
    .update("\0")
    .update(releaseManifest)
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

function createRunnerExecutableProvider(
  version: string,
  build: RunnerExecutableBuilder,
  buildSupervisor: RunnerExecutableBuilder,
): RunnerExecutableProvider {
  if (!RUNNER_VERSION_PATTERN.test(version)) {
    throw new Error("The runner version must be a SHA-256 digest");
  }
  const executables: RunnerExecutableSource = { build, cache: new Map() };
  const supervisors: RunnerExecutableSource = {
    build: buildSupervisor,
    cache: new Map(),
  };
  const load = (
    target: RunnerExecutableTarget,
    source: RunnerExecutableSource,
  ): Promise<RunnerExecutable> => {
    const existing = source.cache.get(target);
    if (existing !== undefined) return existing;
    const pending = Promise.resolve()
      .then(() => source.build(target))
      .then(async (body) => ({
        body,
        sha256: createHash("sha256")
          .update(new Uint8Array(await body.arrayBuffer()))
          .digest("hex"),
      }));
    source.cache.set(target, pending);
    void pending.catch(() => {
      if (source.cache.get(target) === pending) source.cache.delete(target);
    });
    return pending;
  };
  const serveDownload = async (
    request: Request,
    source: RunnerExecutableSource,
  ): Promise<Response> => {
    const targetValue = new URL(request.url).searchParams.get("target");
    if (targetValue === null || !isRunnerExecutableTarget(targetValue))
      return new Response("Not found", { status: 404 });
    const tag = entityTag(version);
    const cacheHeaders = new Headers({
      "cache-control": "no-cache",
      etag: tag,
    });
    if (acceptsEntityTag(request, tag))
      return new Response(null, { headers: cacheHeaders, status: 304 });
    try {
      const executable = await load(targetValue, source);
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
  };
  const serve = (
    request: Request,
    source: RunnerExecutableSource,
  ): Promise<Response> =>
    request.method === "GET"
      ? serveDownload(request, source)
      : Promise.resolve(createMethodNotAllowedResponse("GET"));
  return {
    compile: (target, entrypoint) =>
      compileStandaloneExecutable(target, version, entrypoint),
    serve: (request) => serve(request, executables),
    serveSupervisor: (request) => serve(request, supervisors),
    version,
  };
}

export async function buildRunnerExecutableProvider(
  options: RunnerExecutableBuildOptions = {},
): Promise<RunnerExecutableProvider> {
  const version = options.version ?? (await runnerVersion());
  const build =
    options.build ??
    ((target: RunnerExecutableTarget) =>
      compileStandaloneExecutable(target, version));
  const buildSupervisor =
    options.buildSupervisor ??
    ((target: RunnerExecutableTarget) =>
      compileStandaloneExecutable(
        target,
        version,
        RUNNER_SUPERVISOR_ENTRYPOINT,
      ));
  return createRunnerExecutableProvider(version, build, buildSupervisor);
}
