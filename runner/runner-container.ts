import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { platform } from "node:os";
import { abortSignalIsAborted } from "../shared/abort-signal.ts";
import { isRecord } from "../shared/auth-model.ts";
import type { RunnerCommandOutputDelta } from "../shared/runner-command-broker.ts";
import { writePrivateJsonFile } from "./runner-private-file.ts";
import {
  formatRunnerProcessResult,
  runRunnerProcess,
  throwIfRunnerCommandStopped,
  type RunnerProcessOptions,
  type RunnerProcessResult,
} from "./runner-process.ts";

// Arch publishes amd64-only images; hosts that cannot run amd64 (no
// emulation, or a runtime not defaulting to it) need a multi-arch
// Q_MUSH_CONTAINER_IMAGE override (startup fails loudly with that
// guidance otherwise).
const DEFAULT_CONTAINER_IMAGE = "archlinux:latest";
const CONTAINER_WORKSPACE = "/workspace";
const CONTAINER_IDENTIFIER_PATTERN = /^[A-Za-z\d][A-Za-z\d_.-]{0,199}$/u;
type RunnerContainerRunOptions = Pick<
  RunnerProcessOptions,
  "onOutput" | "signal" | "timeoutSeconds"
>;

export type RunnerContainerRun = (
  executable: string,
  arguments_: readonly string[],
  options: RunnerContainerRunOptions,
) => Promise<RunnerProcessResult>;

interface RunnerContainerManagerOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly randomName?: () => string;
  readonly run?: RunnerContainerRun;
  readonly trackingPath?: string;
}

interface RunnerContainerConfiguration {
  readonly image: string;
  readonly runtime: string;
}

function containerConfiguration(
  environment: Readonly<Record<string, string | undefined>>,
): RunnerContainerConfiguration {
  return {
    image: configuredValue(
      environment,
      "Q_MUSH_CONTAINER_IMAGE",
      DEFAULT_CONTAINER_IMAGE,
    ),
    runtime: configuredValue(environment, "Q_MUSH_CONTAINER_RUNTIME", "docker"),
  };
}

interface TrackedContainer {
  readonly identifier: string;
  readonly runtime: string;
}

interface SessionContainer extends TrackedContainer {
  readonly id: string;
  readonly root: string;
}

interface PendingSessionContainer {
  readonly root: string;
  readonly started: Promise<SessionContainer>;
}

interface NewSessionContainer {
  readonly root: string;
  readonly sessionId: string;
  readonly signal: AbortSignal | undefined;
}

async function runContainerProcess(
  executable: string,
  arguments_: readonly string[],
  options: RunnerContainerRunOptions,
): Promise<RunnerProcessResult> {
  throwIfRunnerCommandStopped(options.signal);
  try {
    return await runRunnerProcess({
      arguments: arguments_,
      executable,
      ...options,
    });
  } catch (error) {
    throw new Error(
      `Container execution is unavailable: could not start ${executable}`,
      { cause: error },
    );
  }
}

function processOptions(
  signal: AbortSignal | undefined,
  timeoutSeconds?: number,
  onOutput?: (delta: Omit<RunnerCommandOutputDelta, "sequence">) => void,
): RunnerContainerRunOptions {
  return {
    ...(onOutput === undefined ? {} : { onOutput }),
    ...(signal === undefined ? {} : { signal }),
    ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
  };
}

function validContainerIdentifier(value: string): boolean {
  return CONTAINER_IDENTIFIER_PATTERN.test(value);
}

function containerIdentifier(runtimeOutput: string): string | undefined {
  const id = runtimeOutput.trim();
  return validContainerIdentifier(id) ? id : undefined;
}

function configuredValue(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: string,
): string {
  const value = environment[name]?.trim();
  return value === undefined || value.length === 0 ? fallback : value;
}

function runtimeArguments(
  root: string,
  name: string,
  image: string,
): readonly string[] {
  const mount = `type=bind,source=${root},target=${CONTAINER_WORKSPACE}`;
  // The session container is the agent's own disposable machine: root with
  // the runtime's default capabilities and network access, so package
  // installs (pacman on the default Arch image) work. Isolation comes from
  // the container boundary and per-session teardown, not host-uid mapping.
  // --user 0:0 enforces the root contract even when an override image
  // declares a USER directive.
  return [
    "run",
    "--detach",
    "--rm",
    "--name",
    name,
    "--label",
    "dev.q-mush.owner=session",
    "--init",
    "--user",
    "0:0",
    "--mount",
    mount,
    "--workdir",
    CONTAINER_WORKSPACE,
    "--entrypoint",
    "/bin/sh",
    image,
    "-c",
    "while :; do sleep 3600; done",
  ];
}

function containerWasAbsent(result: RunnerProcessResult): boolean {
  const detail =
    `${result.standardError}\n${result.standardOutput}`.toLowerCase();
  return (
    detail.includes("no such container") ||
    detail.includes("no container with name or id") ||
    detail.includes("container does not exist")
  );
}

function processError(
  runtime: string,
  action: string,
  result: RunnerProcessResult,
): Error {
  // Match the full detail: pull chatter often pushes the diagnostic past
  // the displayed prefix. The platform branch bounds its gap so long
  // single-line outputs cannot trigger measurable backtracking.
  const fullDetail =
    result.standardError.trim() || result.standardOutput.trim();
  const detail = fullDetail.slice(0, 500);
  // The default Arch image is amd64-only; hosts that cannot run it (ARM64
  // without emulation) need the image override, so say so. Docker reports
  // "no matching manifest", Podman "no image found in image index (or
  // manifest list) for architecture"; emulated pulls that succeed can
  // still fail at start with "exec format error".
  const guidance =
    /no matching manifest|no image found in (?:image index|manifest list) for architecture|platform[^\n]{0,200}does not match|exec format error/iu.test(
      fullDetail,
    )
      ? " The configured image does not support this host architecture; set Q_MUSH_CONTAINER_IMAGE to a compatible image."
      : "";
  const separator = /[.!?]$/u.test(detail) ? "" : ".";
  return new Error(
    `Container execution is unavailable: ${runtime} could not ${action}${detail.length === 0 ? "" : `: ${detail}`}${separator}${guidance}`,
  );
}

function formatShellResult(
  result: RunnerProcessResult,
  timeoutSeconds: number,
): string {
  return formatRunnerProcessResult(result, timeoutSeconds);
}

function readTrackedContainers(
  path: string | undefined,
): Map<string, TrackedContainer> {
  if (path === undefined) {
    return new Map();
  }
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(value)) {
      return new Map();
    }
    const tracked = new Map<string, TrackedContainer>();
    for (const [sessionId, candidate] of Object.entries(value)) {
      if (
        isRecord(candidate) &&
        typeof candidate["identifier"] === "string" &&
        validContainerIdentifier(candidate["identifier"]) &&
        typeof candidate["runtime"] === "string" &&
        candidate["runtime"].length > 0 &&
        candidate["runtime"].length <= 4_096
      ) {
        tracked.set(sessionId, {
          identifier: candidate["identifier"],
          runtime: candidate["runtime"],
        });
      }
    }
    return tracked;
  } catch {
    return new Map();
  }
}

export class RunnerContainerManager {
  readonly #containers = new Map<
    string,
    PendingSessionContainer | SessionContainer
  >();
  readonly #cleanups = new Map<string, Promise<void>>();
  readonly #image: string;
  readonly #randomName: () => string;
  readonly #run: RunnerContainerRun;
  readonly #runtime: string;
  readonly #tracked: Map<string, TrackedContainer>;
  readonly #trackingPath: string | undefined;

  constructor(options: RunnerContainerManagerOptions = {}) {
    const environment = options.environment ?? process.env;
    const configuration = containerConfiguration(environment);
    this.#runtime = configuration.runtime;
    this.#image = configuration.image;
    this.#randomName =
      options.randomName ??
      (() => `q-mush-session-${randomBytes(16).toString("hex")}`);
    this.#run = options.run ?? runContainerProcess;
    this.#trackingPath = options.trackingPath;
    this.#tracked = readTrackedContainers(this.#trackingPath);
  }

  async #removeTracked(
    sessionId: string,
    tracked: TrackedContainer,
  ): Promise<boolean> {
    if (!validContainerIdentifier(tracked.identifier)) {
      return false;
    }
    try {
      const result = await this.#run(
        tracked.runtime,
        ["rm", "--force", tracked.identifier],
        {},
      );
      if (result.exitCode === 0 || containerWasAbsent(result)) {
        this.#tracked.delete(sessionId);
        return true;
      }
    } catch {
      // Keep the record so a future attempt can retry exact cleanup.
    }
    return false;
  }

  async #removeSessionContainer(
    sessionId: string,
    tracked: TrackedContainer,
  ): Promise<void> {
    if (await this.#removeTracked(sessionId, tracked)) {
      this.#writeTracking();
    }
  }

  async recoverTracked(): Promise<void> {
    for (const [sessionId, tracked] of [...this.#tracked.entries()]) {
      await this.#removeTracked(sessionId, tracked);
    }
    this.#writeTracking();
  }

  async prepare(
    sessionId: string,
    root: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#container(sessionId, root, signal);
  }

  async executeShell(
    sessionId: string,
    root: string,
    command: string,
    timeoutSeconds: number,
    signal?: AbortSignal,
    onOutput?: (delta: Omit<RunnerCommandOutputDelta, "sequence">) => void,
  ): Promise<string> {
    if (abortSignalIsAborted(signal)) {
      throw new Error("The runner command was stopped");
    }
    const container = await this.#container(sessionId, root, signal);
    if (abortSignalIsAborted(signal)) {
      await this.cleanupSession(sessionId);
      throw new Error("The runner command was stopped");
    }
    let result: RunnerProcessResult;
    try {
      result = await this.#run(
        container.runtime,
        [
          "exec",
          "--workdir",
          CONTAINER_WORKSPACE,
          container.id,
          "/bin/sh",
          "-lc",
          command,
        ],
        processOptions(signal, timeoutSeconds, onOutput),
      );
    } catch (error) {
      if (abortSignalIsAborted(signal)) {
        await this.cleanupSession(sessionId);
      }
      throw error;
    }
    if (result.termination !== undefined) {
      await this.cleanupSession(sessionId);
    }
    return formatShellResult(result, timeoutSeconds);
  }

  async cleanupSession(sessionId: string): Promise<void> {
    const existing = this.#cleanups.get(sessionId);
    if (existing !== undefined) {
      return existing;
    }
    const cleanup = this.#cleanupSession(sessionId);
    this.#cleanups.set(sessionId, cleanup);
    try {
      await cleanup;
    } finally {
      if (this.#cleanups.get(sessionId) === cleanup) {
        this.#cleanups.delete(sessionId);
      }
    }
  }

  async #cleanupSession(sessionId: string): Promise<void> {
    const stored = this.#containers.get(sessionId);
    this.#containers.delete(sessionId);
    let tracked = this.#tracked.get(sessionId);
    if (stored !== undefined) {
      try {
        const container = "started" in stored ? await stored.started : stored;
        tracked = { identifier: container.id, runtime: container.runtime };
      } catch {
        // Fall through to the durable unique identifier, if one was recorded.
      }
    }
    if (tracked === undefined) {
      return;
    }
    await this.#removeSessionContainer(sessionId, tracked);
  }

  async cleanupAll(): Promise<void> {
    const sessionIds = new Set([
      ...this.#containers.keys(),
      ...this.#tracked.keys(),
    ]);
    await Promise.allSettled(
      [...sessionIds].map((sessionId) => this.cleanupSession(sessionId)),
    );
  }

  async #container(
    sessionId: string,
    root: string,
    signal?: AbortSignal,
  ): Promise<SessionContainer> {
    const existing = this.#existingContainer(sessionId, root);
    if (existing !== undefined) {
      return "started" in existing ? await existing.started : existing;
    }
    const cleanup = this.#cleanups.get(sessionId);
    if (cleanup !== undefined) {
      await cleanup;
      return this.#container(sessionId, root, signal);
    }
    const orphan = this.#tracked.get(sessionId);
    if (orphan !== undefined) {
      await this.#removeSessionContainer(sessionId, orphan);
      if (this.#tracked.has(sessionId)) {
        throw new Error(
          "Container execution is unavailable: the previous session container could not be removed",
        );
      }
    }
    if (abortSignalIsAborted(signal)) {
      throw new Error("The runner command was stopped");
    }
    return this.#createContainer({ root, sessionId, signal });
  }

  async #createContainer(
    options: NewSessionContainer,
  ): Promise<SessionContainer> {
    const pending = this.#pendingContainer(options);
    this.#containers.set(options.sessionId, pending);
    try {
      const started = await pending.started;
      this.#replacePendingContainer(options.sessionId, pending, started);
      return started;
    } catch (error) {
      this.#replacePendingContainer(options.sessionId, pending);
      throw error;
    }
  }

  #replacePendingContainer(
    sessionId: string,
    pending: PendingSessionContainer,
    started?: SessionContainer,
  ): void {
    if (this.#containers.get(sessionId) !== pending) {
      return;
    }
    if (started === undefined) {
      this.#containers.delete(sessionId);
    } else {
      this.#containers.set(sessionId, started);
    }
  }

  #pendingContainer(options: NewSessionContainer): PendingSessionContainer {
    return {
      root: options.root,
      started: this.#start(options),
    };
  }

  #existingContainer(
    sessionId: string,
    root: string,
  ): PendingSessionContainer | SessionContainer | undefined {
    const existing = this.#containers.get(sessionId);
    if (existing !== undefined && existing.root !== root) {
      throw new Error("The session container workspace changed");
    }
    return existing;
  }

  #forgetSession(sessionId: string): void {
    this.#tracked.delete(sessionId);
    this.#writeTracking();
  }

  async #stoppedDuringStart(
    sessionId: string,
    tracked: TrackedContainer,
    cause?: unknown,
  ): Promise<never> {
    await this.#removeSessionContainer(sessionId, tracked);
    throw new Error("The runner command was stopped", {
      ...(cause === undefined ? {} : { cause }),
    });
  }

  async #start(options: NewSessionContainer): Promise<SessionContainer> {
    const { root, sessionId, signal } = options;
    if (platform() === "win32") {
      throw new Error(
        "Container execution is unavailable on this runner platform",
      );
    }
    const name = this.#randomName();
    const starting = {
      identifier: name,
      runtime: this.#runtime,
    };
    this.#tracked.set(sessionId, starting);
    this.#writeTracking();
    let result: RunnerProcessResult;
    try {
      result = await this.#run(
        this.#runtime,
        runtimeArguments(root, name, this.#image),
        processOptions(signal),
      );
    } catch (error) {
      if (abortSignalIsAborted(signal)) {
        return this.#stoppedDuringStart(sessionId, starting, error);
      }
      this.#forgetSession(sessionId);
      throw new Error(
        `Container execution is unavailable: could not start ${this.#runtime}. Install Docker or Podman, or configure Q_MUSH_CONTAINER_RUNTIME.`,
        { cause: error },
      );
    }
    if (abortSignalIsAborted(signal) || result.termination === "stopped") {
      return this.#stoppedDuringStart(sessionId, starting);
    }
    if (result.exitCode !== 0) {
      await this.#removeSessionContainer(sessionId, starting);
      throw processError(this.#runtime, "start the configured image", result);
    }
    const id = containerIdentifier(result.standardOutput);
    if (id === undefined) {
      await this.#removeSessionContainer(sessionId, starting);
      throw new Error(
        `Container execution is unavailable: ${this.#runtime} returned no container ID`,
      );
    }
    this.#tracked.set(sessionId, {
      identifier: id,
      runtime: this.#runtime,
    });
    this.#writeTracking();
    return {
      id,
      identifier: id,
      root,
      runtime: this.#runtime,
    };
  }

  #writeTracking(): void {
    const path = this.#trackingPath;
    if (path === undefined) {
      return;
    }
    writePrivateJsonFile(path, Object.fromEntries(this.#tracked));
  }
}
