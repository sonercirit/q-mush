import {
  registerReconciliationTests,
  sessionDetail,
  startedHydrationScenario,
  uncertainCreationScenario,
  uncertainStopScenario,
  unloadedCreationReconciliationScenario,
} from "./session-controller-reconciliation-fixtures.ts";
import { TEST_SESSION_DETAIL } from "./session-fixtures.ts";

registerReconciliationTests({
  "correlates uncertain creation with the submitted draft": async () => {
    const run = await uncertainCreationScenario();
    run.scenario.controller.setDraftField("prompt", "Changed after submission");
    run.scenario.controller.setDraftField(
      "workingDirectory",
      "/changed/after/submission",
    );
    await run.confirm();

    run.scenario.expectState({
      creating: false,
      draft: {
        prompt: "",
        workingDirectory: "/changed/after/submission",
      },
      selectedId: run.created.id,
    });
    run.expectPayload({
      prompt: "Frozen creation",
      workingDirectory: TEST_SESSION_DETAIL.workingDirectory,
    });
  },

  "does not create before an authoritative session baseline is loaded":
    async () => {
      const scenario = unloadedCreationReconciliationScenario();
      await scenario.controller.create();

      scenario.expectCommandCount("create", 0);
      scenario.expectPending("creating", false);
      scenario.expectError("finish loading");
    },

  "load cannot invalidate an unresolved reconciliation": async () => {
    const reconciliation = await uncertainStopScenario();
    await reconciliation.scenario.controller.load();
    reconciliation.scenario.expectCommandCount("subscribe", 0);
    await reconciliation.resolve({ status: "stopped" });

    reconciliation.scenario.expectPending("stopping", false);
  },

  "discards hydration that overlaps a mutation and retries afterward":
    async () => {
      const { list, scenario } = await startedHydrationScenario();
      const mutation = await scenario.startMutation("stop");
      list.resolveSummaries(sessionDetail({ title: "stale hydration" }));
      scenario.expectListTitleNot("stale hydration");
      await mutation.resolve({ status: "stopped" });

      await scenario.completeHydration(
        sessionDetail({ status: "stopped", title: "fresh hydration" }),
      );
    },

  "waits for reconnect before retrying failed hydration": async () => {
    const { list, scenario } = await startedHydrationScenario();
    list.reject("transport unavailable");
    await scenario.pauseForUnexpectedRetry();
    scenario.expectCommandCount("subscribe", 1);

    scenario.reconnect();
    await scenario.completeHydration(
      sessionDetail({ title: "reconnected hydration" }),
    );
  },

  "keeps a reconnect received during failed hydration queued": async () => {
    const { list, scenario } = await startedHydrationScenario();
    scenario.reconnect();
    list.reject("transport unavailable");

    await scenario.completeHydration(
      sessionDetail({ title: "latest reconnect hydration" }),
    );
  },

  "does not create after the initial session list fails to load": async () => {
    const scenario = unloadedCreationReconciliationScenario();
    await scenario.failInitialLoad("transport unavailable");
    await scenario.controller.create();

    scenario.expectState({ sessions: undefined });
    scenario.expectCommandCount("create", 0);
    scenario.expectError("finish loading");
  },

  "preserves the authoritative list when uncertain creation settles":
    async () => {
      const existing = sessionDetail({
        id: "existing-session",
        title: "Existing session",
      });
      const run = await uncertainCreationScenario("Frozen creation", {
        sessions: [existing],
      });
      await run.confirm([run.created, existing]);

      run.scenario.expectSessionIds([run.created.id, existing.id]);
    },
});
