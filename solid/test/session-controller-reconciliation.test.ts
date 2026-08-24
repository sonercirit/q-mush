import {
  createdSessionDetail,
  expectCompletedGenerationReconciliation,
  expectMismatchedCreationBlocked,
  registerReconciliationTests,
  selectedReconciliationScenario,
  sessionDetail,
  sessionUserMessage,
  startedActiveMutation,
  uncertainCreationScenario,
  uncertainStopScenario,
} from "./session-controller-reconciliation-fixtures.ts";
import { TEST_SESSION_DETAIL } from "./session-fixtures.ts";

async function confirmCreationOption(
  prompt: string,
  key: "agentFilePath" | "autoCompact" | "idleCompact",
  value: string | boolean,
): Promise<void> {
  const run = await uncertainCreationScenario(prompt, {
    draft: { [key]: value },
  });
  const created = createdSessionDetail(prompt, { [key]: value });
  run.expectPayload({ [key]: value });
  await run.confirmAs(created);
  run.scenario.expectCreatedSessionSelected(created.id);
}

registerReconciliationTests({
  "reconciles an already-executed mutation before unblocking it": async () => {
    const reconciliation = await uncertainStopScenario(
      "command_outcome_unknown",
    );
    const { scenario } = reconciliation;

    scenario.expectPending("stopping");
    scenario.expectDetailSnapshotIgnored("stale snapshot");
    await scenario.expectMutationBlocked("stop");

    await reconciliation.resolve({ status: "stopped" });
    scenario.expectState({ stopping: false });
    scenario.expectError("could not confirm");
    scenario.expectState({ detail: { status: "stopped" } });
  },

  "keeps an uncertain mutation blocked when detail does not confirm it":
    async () => {
      const reconciliation = await uncertainStopScenario();
      await reconciliation.resolve({ status: "running" });

      reconciliation.scenario.expectPending("stopping");
      await reconciliation.scenario.expectMutationBlocked("stop");
    },

  "retries blocked reconciliation before reconnect hydration": async () => {
    const firstAttempt = await uncertainStopScenario();
    await firstAttempt.reject("connection_lost");
    const { scenario } = firstAttempt;
    scenario.expectPending("stopping");

    scenario.reconnect();
    const retry = await scenario.takeRead();
    scenario.expectCommandCount("subscribe", 0);
    retry.resolveDetail({ status: "stopped", title: "reconciled" });
    await scenario.expectEventuallyState({ stopping: false });

    await scenario.completeHydration(
      sessionDetail({ status: "stopped", title: "hydrated" }),
    );
  },

  "retries reconciliation when reconnect arrives during the first read":
    async () => {
      const firstAttempt = await uncertainStopScenario();
      const { scenario } = firstAttempt;
      scenario.reconnect();
      await firstAttempt.reject("connection_lost");

      const retry = await scenario.takeRead();
      scenario.expectPending("stopping");
      retry.resolveDetail({ status: "running" });
      await scenario.expectEventuallyError("could not confirm");
      scenario.expectPending("stopping");

      scenario.reconnect();
      const finalAttempt = await scenario.takeRead();
      finalAttempt.resolveDetail({ status: "stopped" });
      await scenario.expectEventuallyState({ stopping: false });
    },

  "reset fences an in-flight reconciliation response": async () => {
    const reconciliation = await uncertainStopScenario();
    reconciliation.scenario.controller.reset();
    await reconciliation.resolve({ status: "stopped" });

    reconciliation.scenario.expectState({
      detail: undefined,
      selectedId: undefined,
      sessions: undefined,
      stopping: false,
    });
  },

  "reconciles a fast completed compact by its generation": () =>
    expectCompletedGenerationReconciliation("compact", "compacting"),

  "reconciles a fast completed continueSession by its generation": () =>
    expectCompletedGenerationReconciliation("continueSession", "sending"),

  "reconciles a fast completed send by generation and a new message":
    async () => {
      const scenario = selectedReconciliationScenario();
      scenario.controller.setFollowUp("Fast follow-up");
      const mutation = await scenario.startMutation("send");
      await mutation.reconcile(
        sessionDetail({
          generation: 1,
          messages: [sessionUserMessage("user-2", "Fast follow-up", 3)],
          status: "idle",
        }),
      );

      scenario.expectState({ followUp: "", sending: false });
    },

  "does not replace a matching preexisting follow-up during send reconciliation":
    async () => {
      const previous = sessionUserMessage(
        "user-existing",
        "Repeated follow-up",
        2,
      );
      const scenario = selectedReconciliationScenario(
        sessionDetail({ messages: [previous] }),
      );
      scenario.controller.setFollowUp(previous.content);
      const mutation = await scenario.startMutation("send");
      await mutation.reconcile({
        generation: 1,
        messages: [previous],
        status: "idle",
      });

      scenario.expectState({ followUp: previous.content, sending: true });
    },

  "reconciles the session list after uncertain creation": async () => {
    const run = await uncertainCreationScenario("Create once");
    const { scenario } = run;

    scenario.expectPending("creating");
    await scenario.expectMutationBlocked("create");

    const created = createdSessionDetail("Create once");
    const read = await run.publish([created]);
    scenario.expectState({ selectedId: undefined, sessions: [] });
    await run.finishPublished(read, created);

    scenario.expectCreatedSessionSelected(TEST_SESSION_DETAIL.id);
    scenario.expectSessionIds([TEST_SESSION_DETAIL.id]);
    scenario.expectError("could not confirm");
  },

  "threads disabled auto-compaction through creation reconciliation":
    async () => {
      await confirmCreationOption(
        "Create without compaction",
        "autoCompact",
        false,
      );
    },

  "threads a custom agent-file path through creation reconciliation":
    async () => {
      await confirmCreationOption(
        "Create with instructions",
        "agentFilePath",
        "config/instructions.md",
      );
    },

  "keeps creation blocked when the new detail has another agent-file path":
    async () => {
      const run = await uncertainCreationScenario("Correlate instructions", {
        draft: { agentFilePath: "config/instructions.md" },
      });
      await run.confirmAs(createdSessionDetail("Correlate instructions"));

      run.scenario.expectCreationBlocked("Correlate instructions", {
        agentFilePath: "config/instructions.md",
      });
    },

  "keeps creation blocked when the new detail has another auto-compaction mode":
    () => expectMismatchedCreationBlocked({ autoCompact: false }),

  "threads idle compaction through creation reconciliation": async () => {
    await confirmCreationOption(
      "Create with idle compaction",
      "idleCompact",
      true,
    );
  },

  "keeps creation blocked when the new detail has another idle-compaction mode":
    () => expectMismatchedCreationBlocked({ idleCompact: true }),

  "keeps creation blocked when the new detail has another credential": () =>
    expectMismatchedCreationBlocked({ credentialId: "credential-other" }),

  "keeps creation blocked when the new detail has another provider": () =>
    expectMismatchedCreationBlocked({ provider: "openrouter" }),

  "keeps creation blocked when the new detail has another reasoning effort":
    () => expectMismatchedCreationBlocked({ reasoningEffort: null }),

  "keeps creation blocked when the new detail does not match its draft":
    async () => {
      const run = await uncertainCreationScenario("Expected creation");
      const unrelated = sessionDetail({
        messages: [sessionUserMessage("other-user", "Another creation", 2)],
      });
      await run.confirmAs(unrelated);

      run.scenario.expectCreationBlocked("Expected creation");
    },

  "keeps ambiguous uncertain creation blocked without applying its list":
    async () => {
      const run = await uncertainCreationScenario("Ambiguous creation");
      await run.settleList(
        TEST_SESSION_DETAIL,
        sessionDetail({ id: "session-2" }),
      );

      run.scenario.expectState({ creating: true, sessions: [] });
    },

  "does not replace an uncertain creation draft directory while reconciling":
    async () => {
      const originalDirectory = "/original/draft";
      const existing = sessionDetail({
        id: "existing-session",
        workingDirectory: "/existing/session",
      });
      const run = await uncertainCreationScenario("Keep my directory", {
        draft: { workingDirectory: originalDirectory },
        sessions: [existing],
      });
      await run.settleList(existing);

      run.scenario.expectState({
        creating: false,
        draft: { workingDirectory: originalDirectory },
      });
    },

  "retries uncertain creation reconciliation on reconnect": async () => {
    const run = await uncertainCreationScenario(
      "Retry creation reconciliation",
    );
    await run.rejectList("connection_lost");
    run.scenario.expectPending("creating");

    run.scenario.reconnect();
    const created = createdSessionDetail("Retry creation reconciliation");
    await run.scenario.completeCreationReconciliation(created);

    await run.scenario.expectEventuallyCreatedSessionSelected(
      TEST_SESSION_DETAIL.id,
    );
  },

  "gates reconnect hydration and snapshots behind reconciliation": async () => {
    const { mutation, scenario } = await startedActiveMutation("stop");
    scenario.reconnect();
    scenario.expectSnapshotsIgnored("stale list", "stale detail");
    scenario.expectCommandCount("subscribe", 0);

    const reconciliation = await mutation.rejectUnknown(
      "command_outcome_unknown",
    );
    scenario.expectSnapshotsIgnored("still stale", "still stale");
    await reconciliation.resolve({ status: "stopped" });

    await scenario.completeHydration(sessionDetail({ title: "hydrated" }));
  },
});
