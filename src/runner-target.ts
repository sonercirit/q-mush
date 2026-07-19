export const RUNNER_TARGETS = {
  darwinArm64: "bun-darwin-arm64",
  darwinX64: "bun-darwin-x64-baseline",
  linuxArm64: "bun-linux-arm64",
  linuxArm64Musl: "bun-linux-arm64-musl",
  linuxX64: "bun-linux-x64-baseline",
  linuxX64Musl: "bun-linux-x64-baseline-musl",
} as const;

const RUNNER_EXECUTABLE_TARGETS = [
  RUNNER_TARGETS.darwinArm64,
  RUNNER_TARGETS.darwinX64,
  RUNNER_TARGETS.linuxArm64,
  RUNNER_TARGETS.linuxArm64Musl,
  RUNNER_TARGETS.linuxX64,
  RUNNER_TARGETS.linuxX64Musl,
] as const;

export type RunnerExecutableTarget = (typeof RUNNER_EXECUTABLE_TARGETS)[number];

export function isRunnerExecutableTarget(
  value: string,
): value is RunnerExecutableTarget {
  return RUNNER_EXECUTABLE_TARGETS.some((target) => target === value);
}
