import { describe, expect, test } from "vitest";
import { RunnerUpdateTrigger } from "../../runner/runner-update-trigger.ts";
import { RUNNER_VERSION_HEADER } from "../../shared/routes.ts";

const INSTALLED_RUNNER_VERSION = "a".repeat(64);
const ADVERTISED_RUNNER_VERSION = "b".repeat(64);
const NEWER_RUNNER_VERSION = "c".repeat(64);

function advertisedVersion(version?: string): Response {
  const headers = new Headers();

  if (version !== undefined) {
    headers.set(RUNNER_VERSION_HEADER, version);
  }

  return new Response(null, { headers });
}

function requestedUpdates(
  versions: readonly (string | undefined)[],
): boolean[] {
  const trigger = new RunnerUpdateTrigger(INSTALLED_RUNNER_VERSION);

  return versions.map((version) => {
    trigger.observe(advertisedVersion(version));
    return trigger.take();
  });
}

describe("runner update trigger", () => {
  test("requests one immediate update check for each advertised version", () => {
    expect(
      requestedUpdates([
        ADVERTISED_RUNNER_VERSION,
        ADVERTISED_RUNNER_VERSION,
        NEWER_RUNNER_VERSION,
      ]),
    ).toEqual([true, false, true]);
  });

  test("ignores absent, malformed, and current version advertisements", () => {
    expect(
      requestedUpdates([undefined, "next", INSTALLED_RUNNER_VERSION]),
    ).toEqual([false, false, false]);
  });
});
