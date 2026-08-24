import { expect, test, vi } from "vitest";
import type { AgentSessionDetail } from "../../shared/session-model.ts";
import { createReactiveState } from "../../solid/reactive-state.ts";
import type { SessionViewState } from "../../solid/session-client.tsx";
import {
  createSessionController,
  type SessionController,
} from "../../solid/session-controller.ts";
import { summaryFromDetail } from "../../solid/session-summary-codec.ts";
import {
  createdSessionDetail,
  sessionDetail,
} from "./session-controller-reconciliation-detail-fixtures.ts";
import {
  createControlledSessionTransport,
  createdSelectionState,
  createStartedSessionMutation,
  createUnknownCreationReconciliation,
  type CreationScenarioOptions,
  creationState,
  type DetailMutationReconciliation,
  MUTATION_OPERATIONS,
  type PendingSessionCommand,
  publishDetail,
  rejectCommand,
  selectedState,
  type StartedSessionMutation,
  type UnknownCreationReconciliation,
} from "./session-controller-reconciliation-transport-fixtures.ts";
import type {
  ControllerMutationName,
  OperationName,
  PendingFlag,
  ReconciliationTest,
  SessionMutationName,
  StateMatch,
} from "./session-controller-reconciliation-types.ts";

export {
  createdSessionDetail,
  sessionDetail,
  sessionUserMessage,
} from "./session-controller-reconciliation-detail-fixtures.ts";
export interface ReconciliationScenario {
  readonly controller: SessionController;
  completeCreationReconciliation(
    detail: AgentSessionDetail,
    sessions?: readonly AgentSessionDetail[],
  ): Promise<void>;
  completeHydration(detail: AgentSessionDetail): Promise<void>;
  expectCommandCount(name: OperationName, count: number): void;
  expectCreationBlocked(
    prompt: string,
    draft?: Readonly<Record<string, unknown>>,
  ): void;
  expectCreatedSessionSelected(sessionId: string): void;
  expectEventuallyCreatedSessionSelected(sessionId: string): Promise<void>;
  expectDetailSnapshotIgnored(title: string): void;
  expectError(fragment: string): void;
  expectEventuallyError(fragment: string): Promise<void>;
  expectEventuallyState(expected: StateMatch): Promise<void>;
  expectListTitleNot(title: string): void;
  expectMutationBlocked(name: ControllerMutationName): Promise<void>;
  expectPending(flag: PendingFlag, expected?: boolean): void;
  expectSessionIds(expected: readonly string[]): void;
  expectSnapshotsIgnored(listTitle: string, detailTitle: string): void;
  expectState(expected: StateMatch): void;
  failInitialLoad(message: string): Promise<void>;
  pauseForUnexpectedRetry(): Promise<void>;
  publishSessionList(
    command: PendingSessionCommand,
    sessions: readonly AgentSessionDetail[],
  ): Promise<PendingSessionCommand>;
  reconnect(): void;
  startHydration(): Promise<PendingSessionCommand>;
  startMutation(name: SessionMutationName): Promise<StartedSessionMutation>;
  startUnknownCreation(
    prompt: string,
    message?: string,
  ): Promise<UnknownCreationReconciliation>;
  takeRead(): Promise<PendingSessionCommand>;
}

function createReconciliationScenario(
  state: SessionViewState,
): ReconciliationScenario {
  const transport = createControlledSessionTransport();
  const controller = createSessionController(
    createReactiveState(state),
    undefined,
    null,
    transport,
  );
  const takeSessionList = () => transport.take("subscribe");
  const scenario: ReconciliationScenario & {
    failLoadCommand(loading: Promise<void>, message: string): Promise<void>;
  } = {
    controller,
    completeCreationReconciliation: async (detail, sessions) => {
      const list = await takeSessionList();
      await publishDetail(
        (published) => scenario.publishSessionList(list, published),
        detail,
        sessions ?? [detail],
      );
    },

    async completeHydration(detail: AgentSessionDetail): Promise<void> {
      const list = await takeSessionList();
      list.resolveSummaries(detail);
      const read = await transport.take("read");
      read.resolve(detail);
      await scenario.expectEventuallyState({ detail: { title: detail.title } });
    },

    expectCommandCount(name: OperationName, count: number): void {
      transport.expectCount(name, count);
    },

    expectCreationBlocked(
      prompt: string,
      draft: Readonly<Record<string, unknown>> = {},
    ): void {
      scenario.expectState({
        creating: true,
        draft: { ...draft, prompt },
        sessions: [],
      });
    },

    expectCreatedSessionSelected(sessionId: string): void {
      scenario.expectState(createdSelectionState(sessionId));
    },

    expectEventuallyCreatedSessionSelected(sessionId: string) {
      return vi.waitFor(() => {
        scenario.expectCreatedSessionSelected(sessionId);
      });
    },

    expectDetailSnapshotIgnored(title: string): void {
      controller.applyDetail(sessionDetail({ title }));
      expect(controller.state.detail?.title).not.toBe(title);
    },

    expectError(fragment: string): void {
      expect(controller.state.error).toContain(fragment);
    },

    expectEventuallyError(fragment: string) {
      return vi.waitFor(() => {
        scenario.expectError(fragment);
      });
    },

    expectEventuallyState(expected: StateMatch) {
      return vi.waitFor(() => {
        scenario.expectState(expected);
      });
    },

    expectListTitleNot(title: string): void {
      expect(controller.state.sessions?.[0]?.title).not.toBe(title);
    },

    async expectMutationBlocked(name: ControllerMutationName): Promise<void> {
      const count = transport.count(MUTATION_OPERATIONS[name]);
      await controller[name]();
      scenario.expectCommandCount(MUTATION_OPERATIONS[name], count);
    },

    expectPending(flag: PendingFlag, expected = true): void {
      expect(controller.state[flag]).toBe(expected);
    },

    expectSessionIds(expected: readonly string[]): void {
      expect(controller.state.sessions?.map(({ id }) => id)).toEqual(expected);
    },

    expectSnapshotsIgnored(listTitle: string, detailTitle: string): void {
      controller.applyRealtime([
        summaryFromDetail(sessionDetail({ title: listTitle })),
      ]);
      scenario.expectDetailSnapshotIgnored(detailTitle);
      scenario.expectListTitleNot(listTitle);
    },

    expectState(expected: StateMatch): void {
      expect(controller.state).toMatchObject(expected);
    },

    failInitialLoad(message: string): Promise<void> {
      return scenario.failLoadCommand(controller.load(), message);
    },

    async failLoadCommand(
      loading: Promise<void>,
      message: string,
    ): Promise<void> {
      const list = await takeSessionList();
      await rejectCommand(list, loading, message);
    },

    async pauseForUnexpectedRetry(): Promise<void> {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 10);
      });
    },

    async publishSessionList(
      command: PendingSessionCommand,
      sessions: readonly AgentSessionDetail[],
    ): Promise<PendingSessionCommand> {
      command.resolveSummaries(...sessions);
      return transport.take("read");
    },

    reconnect(): void {
      transport.reconnect();
    },

    async startHydration(): Promise<PendingSessionCommand> {
      scenario.reconnect();
      return transport.take("subscribe");
    },

    async startMutation(
      name: SessionMutationName,
    ): Promise<StartedSessionMutation> {
      const completion = controller[name]();
      const command = await transport.take(MUTATION_OPERATIONS[name]);
      return createStartedSessionMutation(scenario, completion, command);
    },

    async startUnknownCreation(
      prompt: string,
      message = "outcome_unknown",
    ): Promise<UnknownCreationReconciliation> {
      const completion = controller.create();
      const mutation = await transport.take("create");
      mutation.reject(message);
      const list = await transport.take("subscribe");
      return createUnknownCreationReconciliation(
        scenario,
        completion,
        mutation,
        list,
        prompt,
      );
    },

    async takeRead(): Promise<PendingSessionCommand> {
      return transport.take("read");
    },
  };
  return scenario;
}

function activeReconciliationScenario(): ReconciliationScenario {
  const running = sessionDetail({ status: "running" });
  return createReconciliationScenario(
    selectedState({ detail: running, sessions: [summaryFromDetail(running)] }),
  );
}
function creationReconciliationScenario(
  prompt = "Frozen creation",
  options: CreationScenarioOptions = {},
): ReconciliationScenario {
  return createReconciliationScenario(creationState(prompt, options));
}
export function selectedReconciliationScenario(
  detail: AgentSessionDetail = sessionDetail(),
): ReconciliationScenario {
  return createReconciliationScenario(selectedState({ detail }));
}
export function unloadedCreationReconciliationScenario(): ReconciliationScenario {
  return creationReconciliationScenario("Frozen creation", {
    sessions: undefined,
  });
}

interface StartedActiveMutation {
  readonly mutation: StartedSessionMutation;
  readonly scenario: ReconciliationScenario;
}

interface StartedHydration {
  readonly list: PendingSessionCommand;
  readonly scenario: ReconciliationScenario;
}

export async function uncertainStopScenario(
  message = "outcome_unknown",
): Promise<DetailMutationReconciliation> {
  const { mutation } = await startedActiveMutation("stop");
  return mutation.rejectUnknown(message);
}

export async function startedActiveMutation(
  action: SessionMutationName,
): Promise<StartedActiveMutation> {
  const scenario = activeReconciliationScenario();
  return { mutation: await scenario.startMutation(action), scenario };
}

export async function uncertainCreationScenario(
  prompt = "Frozen creation",
  options: CreationScenarioOptions = {},
): Promise<UnknownCreationReconciliation> {
  const scenario = creationReconciliationScenario(prompt, options);
  return scenario.startUnknownCreation(prompt);
}

export async function startedHydrationScenario(): Promise<StartedHydration> {
  const scenario = activeReconciliationScenario();
  return { list: await scenario.startHydration(), scenario };
}

export async function expectCompletedGenerationReconciliation(
  action: "compact" | "continueSession",
  pending: "compacting" | "sending",
): Promise<void> {
  const scenario = selectedReconciliationScenario();
  const mutation = await scenario.startMutation(action);
  await mutation.reconcile({ generation: 1, status: "idle" });
  scenario.expectPending(pending, false);
}

export async function expectMismatchedCreationBlocked(
  change: Partial<AgentSessionDetail>,
): Promise<void> {
  const run = await uncertainCreationScenario("Correlate creation", {
    draft: { reasoningEffort: "high" },
  });
  const unrelated = createdSessionDetail("Correlate creation", {
    reasoningEffort: "high",
    ...change,
  });
  await run.confirmAs(unrelated);
  run.scenario.expectCreationBlocked("Correlate creation", {
    reasoningEffort: "high",
  });
}

export function registerReconciliationTests(
  scenarios: Record<string, ReconciliationTest>,
): void {
  for (const [name, run] of Object.entries(scenarios)) {
    test(name, run);
  }
}
