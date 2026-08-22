import { describe, expect, test } from "vitest";
import { balancedCredentialId } from "../../shared/provider-credential-pool.ts";
import { TEST_USER_ID } from "./authenticated-integration-test-helpers.ts";
import {
  CREDENTIAL_ID,
  REPLACEMENT_RUNNER_ID,
} from "./session-integration-fixtures.ts";
import {
  activeRuntime,
  authoritySetup,
  CHILD_SESSION_ID,
  closeAuthoritySetup,
  closeSetup,
  createStoredSession,
  credentialCaseSetup,
  expectCompactionRejected,
  expectCompactionScheduled,
  expectDeadlineRejection,
  expectOnlyParentSession,
  expectPendingCompaction,
  expectSessionActionThrows,
  expectSpawnWithoutLaunch,
  expectStaleSpawn,
  expectTargetUnchanged,
  expectTargetUnchangedAfterFencing,
  fenceParent,
  FOREIGN_WORKSPACE_ID,
  immediateMutationCases,
  immediateMutationSetup,
  setupWithTarget,
  spawnInput,
  TARGET_SESSION_ID,
  targetDetail,
  targetOperation,
} from "./session-parent-authority-test-helpers.ts";

function expectParentStale(output: string): void {
  expect(output).toContain("parent_stale");
}

function expectFailedChild(setup: ReturnType<typeof authoritySetup>): void {
  expect(
    setup.store.list(TEST_USER_ID).some(({ status }) => status === "failed"),
  ).toBe(true);
}

describe("cross-session parent execution authority", () => {
  test.each(immediateMutationCases())(
    "rejects canceled $name before mutating the target",
    async ({ execute, name }) => {
      const setup = immediateMutationSetup(name);
      const before = targetDetail(setup);
      const deadline = new AbortController();
      deadline.abort(
        new DOMException("The tool call timed out", "TimeoutError"),
      );

      await expect(
        Promise.resolve().then(() => execute(setup, deadline.signal)),
      ).rejects.toThrow("timed out");
      expectTargetUnchanged(setup, before);
      expect(setup.notify).not.toHaveBeenCalled();
      closeSetup(setup);
    },
  );
  test.each(["compact", "continue", "send"] as const)(
    "rejects credential-paused %s after the parent is fenced",
    async (operation) => {
      const { before, setup } = credentialCaseSetup();
      const result = targetOperation(
        setup,
        operation,
        new AbortController().signal,
      );
      await expectTargetUnchangedAfterFencing(
        setup,
        setup.credentialGate,
        before,
        result,
      );
    },
  );

  test("rejects stale compact and steer actions before mutating the target", () => {
    const setup = setupWithTarget("running");
    const before = setup.store.get(TEST_USER_ID, TARGET_SESSION_ID);
    fenceParent(setup);

    expectSessionActionThrows(
      () =>
        setup.actions.compactSession(
          TARGET_SESSION_ID,
          new AbortController().signal,
        ),
      "stopped",
    );
    expectSessionActionThrows(
      () =>
        setup.actions.steerSession(
          TARGET_SESSION_ID,
          "stale steering",
          new AbortController().signal,
        ),
      "stopped",
    );
    expectTargetUnchanged(setup, before);
    closeAuthoritySetup(setup);
  });

  test("rejects missing and cross-workspace compact or steer targets", async () => {
    const setup = setupWithTarget("running");
    const foreign = createStoredSession(
      setup.store,
      CHILD_SESSION_ID,
      REPLACEMENT_RUNNER_ID,
      FOREIGN_WORKSPACE_ID,
    );

    await expectCompactionRejected(setup, "missing-session");
    expectSessionActionThrows(
      () =>
        setup.actions.steerSession(
          "missing-session",
          "Do not deliver",
          new AbortController().signal,
        ),
      "Session not found",
    );
    await expectCompactionRejected(setup, foreign.id);
    expectSessionActionThrows(
      () =>
        setup.actions.steerSession(
          foreign.id,
          "Do not cross scope",
          new AbortController().signal,
        ),
      "Session not found",
    );
    closeSetup(setup);
  });

  test("idle compaction launches compact-and-continue", async () => {
    const setup = setupWithTarget("idle");

    await expectCompactionScheduled(setup);
    expect(setup.launchOperations).toEqual(["compact_and_continue"]);
    closeSetup(setup);
  });

  test("running compaction schedules once at the next step boundary", async () => {
    const setup = setupWithTarget("running");
    const { runtime, target } = activeRuntime(setup);
    await expectPendingCompaction(setup, target);
    expect(setup.launchOperations).toEqual([]);
    expect(
      await setup.actions.compactSession(
        TARGET_SESSION_ID,
        new AbortController().signal,
      ),
    ).toContain("compaction_already_scheduled");
    expect(
      setup.store.manualCompactionPending(TARGET_SESSION_ID, target.generation),
    ).toBe(true);
    runtime.resolve();
    closeSetup(setup);
  });

  test("steers only a running target and points idle callers to send_to_session", async () => {
    const running = setupWithTarget("running");

    await expect(
      running.actions.steerSession(
        TARGET_SESSION_ID,
        "Change direction",
        new AbortController().signal,
      ),
    ).resolves.toContain("steering_scheduled");
    expect(
      running.store.get(TEST_USER_ID, TARGET_SESSION_ID)?.pendingInputs,
    ).toMatchObject([{ content: "Change direction", kind: "steer" }]);
    closeSetup(running);

    const idle = setupWithTarget("idle");
    expect(() =>
      idle.actions.steerSession(
        TARGET_SESSION_ID,
        "Too late",
        new AbortController().signal,
      ),
    ).toThrow("send_to_session");
    closeSetup(idle);
  });

  test.each(["compact", "continue", "send"] as const)(
    "rejects credential-paused %s after the deadline fires",
    async (operation) => {
      const { before, setup } = credentialCaseSetup();
      const deadline = new AbortController();
      await expectDeadlineRejection(
        setup,
        setup.credentialGate,
        deadline,
        targetOperation(setup, operation, deadline.signal),
      );
      expectTargetUnchanged(setup, before);
      closeAuthoritySetup(setup);
    },
  );

  test("queues a prepared child while draining without launching it", async () => {
    const setup = authoritySetup({ draining: true });
    expect(await expectSpawnWithoutLaunch(setup)).toContain(
      '"status": "queued"',
    );
    expect(setup.store.list(TEST_USER_ID)).toHaveLength(2);
    setup.close();
  });

  test("settles a reservation when its prepared child disappears", async () => {
    const setup = authoritySetup({ hidePreparedChild: true });

    expectParentStale(await expectSpawnWithoutLaunch(setup));
    expectFailedChild(setup);
    setup.close();
  });

  test("rejects a requested credential the user does not own", async () => {
    const setup = authoritySetup({});
    expect(
      await expectSpawnWithoutLaunch(setup, {
        ...spawnInput(),
        credentialId: "unknown-credential",
      }),
    ).toContain("credential_unavailable");
    expectOnlyParentSession(setup);
  });

  test.each([
    {
      balanced: false,
      option: { rejectCredential: true },
      error: "credential boom",
    },
    {
      balanced: true,
      option: { rejectCandidates: true },
      error: "candidate boom",
    },
  ])(
    "discards the reservation when credential access rejects ($error)",
    async ({ balanced, option, error }) => {
      const setup = authoritySetup(option);
      await expect(
        setup.actions.spawnSession(
          {
            ...spawnInput(),
            credentialId: balanced
              ? balancedCredentialId("openai")
              : CREDENTIAL_ID,
          },
          new AbortController().signal,
        ),
      ).rejects.toThrow(error);
      expect(setup.store.list(TEST_USER_ID)).toHaveLength(1);
      expect(setup.launch).not.toHaveBeenCalled();
      setup.close();
    },
  );

  test.each([
    { draining: false, path: "launch" },
    { draining: true, path: "restart queue" },
  ])("rejects a stale parent at the pre-$path claim", async ({ draining }) => {
    const setup = authoritySetup({ draining, fenceOnNotify: true });

    expectParentStale(await expectSpawnWithoutLaunch(setup));
    expectFailedChild(setup);
    closeSetup(setup);
  });

  test("does not create a child when the parent is fenced during credential access", async () => {
    const setup = authoritySetup({ gateCredential: true });
    await expectStaleSpawn(setup.credentialGate, setup);
  });

  test("does not create a child when the parent is fenced during metadata discovery", async () => {
    const setup = authoritySetup({ gateMetadata: true });
    await expectStaleSpawn(setup.metadataGate, setup);
  });

  test("does not create a child when the deadline fires during metadata discovery", async () => {
    const setup = authoritySetup({ gateMetadata: true });
    const deadline = new AbortController();
    await expectDeadlineRejection(
      setup,
      setup.metadataGate,
      deadline,
      setup.actions.spawnSession(spawnInput(), deadline.signal),
    );
    expectOnlyParentSession(setup);
  });
});
