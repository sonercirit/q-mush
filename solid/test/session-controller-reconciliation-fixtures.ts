import { expect, test, vi } from "vitest";
import type { AgentSessionDetail } from "../../shared/session-model.ts";
import {
  SESSION_REALTIME_OPERATIONS,
  type UserRealtimeCommand,
} from "../../shared/user-realtime-protocol.ts";
import { createReactiveState } from "../../solid/reactive-state.ts";
import type { SessionViewState } from "../../solid/session-client.tsx";
import { SessionController } from "../../solid/session-controller.ts";
import { initialSessionViewState } from "../../solid/session-state.ts";
import { summaryFromDetail } from "../../solid/session-summary-codec.ts";
import type { SessionCommandTransport } from "../../solid/session-transport.ts";
import { TEST_SESSION_DETAIL } from "./session-fixtures.ts";
import { transcriptMessage } from "./transcript-ordering-fixtures.ts";

type OperationName = keyof typeof SESSION_REALTIME_OPERATIONS;
type Operation = UserRealtimeCommand["operation"];
type Payload = UserRealtimeCommand["payload"];
type PendingFlag = "compacting" | "creating" | "sending" | "stopping";
type ReconciliationTest = () => Promise<void>;
type StateMatch = Readonly<Record<string, unknown>>;

type SessionMutationName = "compact" | "continueSession" | "send" | "stop";
type ControllerMutationName = SessionMutationName | "create";

const MUTATION_OPERATIONS: Readonly<
  Record<ControllerMutationName, OperationName>
> = {
  compact: "compact",
  continueSession: "continue",
  create: "create",
  send: "send",
  stop: "stop",
};

interface CreationScenarioOptions {
  readonly draft?: Partial<SessionViewState["draft"]>;
  readonly sessions?: readonly AgentSessionDetail[] | undefined;
}

export function sessionDetail(
  changes: Partial<AgentSessionDetail> = {},
): AgentSessionDetail {
  return { ...TEST_SESSION_DETAIL, ...changes };
}

export function createdSessionDetail(
  prompt: string,
  changes: Partial<AgentSessionDetail> = {},
): AgentSessionDetail {
  return sessionDetail({
    ...changes,
    messages: changes.messages ?? [
      transcriptMessage("created-user", prompt, "user", 2),
    ],
  });
}

export function sessionUserMessage(
  id: string,
  content: string,
  createdAt: number,
): AgentSessionDetail["messages"][number] {
  return transcriptMessage(id, content, "user", createdAt);
}

interface PendingSessionCommand {
  readonly operation: Operation;
  readonly payload: Payload;
  expectPayload(expected: object): void;
  reject(message: string): void;
  resolve(value: unknown): void;
  resolveDetail(changes?: Partial<AgentSessionDetail>): void;
  resolveSummaries(...details: readonly AgentSessionDetail[]): void;
}

function createPendingSessionCommand(
  operation: Operation,
  payload: Payload,
  resolvePromise: (value: unknown) => void,
  rejectPromise: (error: unknown) => void,
): PendingSessionCommand {
  return {
    operation,
    payload,
    expectPayload: (expected) => { expect(payload).toMatchObject(expected); },
    reject: (message) => { rejectPromise(new Error(message)); },
    resolve: resolvePromise,
    resolveDetail: (changes = {}) => { resolvePromise(sessionDetail(changes)); },
    resolveSummaries: (...details) => {
      resolvePromise({ sessions: details.map(summaryFromDetail) });
    },
  };
}

interface ControlledSessionTransport extends SessionCommandTransport {
  count(name: OperationName): number;
  expectCount(name: OperationName, count: number): void;
  reconnect(): void;
  take(name: OperationName): Promise<PendingSessionCommand>;
}

function createControlledSessionTransport(): ControlledSessionTransport {
  const commands: PendingSessionCommand[] = [];
  const taken = new Map<OperationName, number>();
  let reconnectListener: (() => void) | undefined;
  const matching = (name: OperationName): readonly PendingSessionCommand[] => {
    const operation = SESSION_REALTIME_OPERATIONS[name];
    return commands.filter((command) => command.operation === operation);
  };
  return {
    command: (operation, payload) => new Promise((resolve, reject) => {
      commands.push(createPendingSessionCommand(operation, payload, resolve, reject));
    }),
    count: (name) => matching(name).length,
    expectCount: (name, count) => { expect(matching(name).length).toBe(count); },
    onReconnect: (listener) => {
      reconnectListener = listener;
      return () => { reconnectListener = undefined; };
    },
    reconnect: () => { reconnectListener?.(); },
    take: async (name) => {
      const index = taken.get(name) ?? 0;
      await vi.waitFor(() => { expect(matching(name).length).toBeGreaterThan(index); });
      const command = matching(name)[index];
      if (command === undefined) throw new Error(`Missing ${SESSION_REALTIME_OPERATIONS[name]} command`);
      taken.set(name, index + 1);
      return command;
    },
  };
}

function selectedState(
  changes: Partial<SessionViewState> = {},
): SessionViewState {
  return {
    ...initialSessionViewState(),
    detail: TEST_SESSION_DETAIL,
    selectedId: TEST_SESSION_DETAIL.id,
    sessions: [summaryFromDetail(TEST_SESSION_DETAIL)],
    ...changes,
  };
}

function creationState(
  prompt: string,
  options: CreationScenarioOptions,
): SessionViewState {
  const draft = {
    ...initialSessionViewState().draft,
    ...options.draft,
    prompt,
  };
  const sessions = Object.hasOwn(options, "sessions")
    ? options.sessions?.map(summaryFromDetail)
    : [];
  return selectedState({
    detail: undefined,
    draft: {
      ...draft,
      credential: draft.credential || "openai:credential-1",
      executionEnvironment: TEST_SESSION_DETAIL.executionEnvironment,
      model: draft.model || TEST_SESSION_DETAIL.model,
      openRouterProviderTag: TEST_SESSION_DETAIL.openRouterProviderTag ?? "",
      runnerId: draft.runnerId || TEST_SESSION_DETAIL.runnerId,
      workingDirectory:
        draft.workingDirectory || TEST_SESSION_DETAIL.workingDirectory,
    },
    selectedId: undefined,
    sessions,
  });
}

async function settleCommand(
  command: PendingSessionCommand,
  completion: Promise<void>,
  value: unknown,
): Promise<void> {
  command.resolve(value);
  await completion;
}

async function rejectCommand(
  command: PendingSessionCommand,
  completion: Promise<void>,
  message: string,
): Promise<void> {
  command.reject(message);
  await completion;
}

function createdSelectionState(sessionId: string): StateMatch {
  return {
    creating: false,
    draft: { prompt: "" },
    selectedId: sessionId,
  };
}

async function publishDetail(
  publish: (
    sessions: readonly AgentSessionDetail[],
  ) => Promise<PendingSessionCommand>,
  detail: AgentSessionDetail,
  sessions: readonly AgentSessionDetail[],
  completion?: Promise<void>,
): Promise<void> {
  const read = await publish(sessions);
  read.resolve(detail);
  await completion;
}

interface PendingSessionAction {
  readonly command: PendingSessionCommand;
  readonly completion: Promise<void>;
  readonly scenario: ReconciliationScenario;
  resolve(changes: Partial<AgentSessionDetail>): Promise<void>;
}
interface StartedSessionMutation extends PendingSessionAction {
  reconcile(changes: Partial<AgentSessionDetail>): Promise<void>;
  rejectUnknown(message?: string): Promise<DetailMutationReconciliation>;
}
interface DetailMutationReconciliation extends PendingSessionAction {
  reject(message: string): Promise<void>;
}
function createPendingSessionAction(
  scenario: ReconciliationScenario,
  completion: Promise<void>,
  command: PendingSessionCommand,
) {
  return {
    command, completion, scenario,
    resolve: (changes: Partial<AgentSessionDetail>) =>
      settleCommand(command, completion, sessionDetail(changes)),
  };
}
function createDetailMutationReconciliation(
  scenario: ReconciliationScenario,
  completion: Promise<void>,
  command: PendingSessionCommand,
): DetailMutationReconciliation {
  return {
    ...createPendingSessionAction(scenario, completion, command),
    reject: (message) => rejectCommand(command, completion, message),
  };
}
function createStartedSessionMutation(
  scenario: ReconciliationScenario,
  completion: Promise<void>,
  command: PendingSessionCommand,
): StartedSessionMutation {
  const base = createPendingSessionAction(scenario, completion, command);
  const rejectUnknown = async (message = "outcome_unknown") => {
    command.reject(message);
    const read = await scenario.takeRead();
    return createDetailMutationReconciliation(scenario, completion, read);
  };
  return {
    ...base,
    rejectUnknown,
    reconcile: async (changes) => { await (await rejectUnknown()).resolve(changes); },
  };
}
interface UnknownCreationReconciliation {
  readonly created: AgentSessionDetail;
  readonly scenario: ReconciliationScenario;
  confirm(sessions?: readonly AgentSessionDetail[]): Promise<void>;
  confirmAs(detail: AgentSessionDetail, sessions?: readonly AgentSessionDetail[]): Promise<void>;
  expectPayload(expected: object): void;
  finishPublished(read: PendingSessionCommand, detail?: AgentSessionDetail): Promise<void>;
  publish(sessions?: readonly AgentSessionDetail[]): Promise<PendingSessionCommand>;
  rejectList(message: string): Promise<void>;
  settleList(...details: readonly AgentSessionDetail[]): Promise<void>;
}
function createUnknownCreationReconciliation(
  scenario: ReconciliationScenario,
  completion: Promise<void>,
  mutation: PendingSessionCommand,
  list: PendingSessionCommand,
  prompt: string,
): UnknownCreationReconciliation {
  const created = createdSessionDetail(prompt);
  const publish = (sessions: readonly AgentSessionDetail[] = [created]) =>
    scenario.publishSessionList(list, sessions);
  const confirmAs = (detail: AgentSessionDetail, sessions: readonly AgentSessionDetail[] = [detail]) =>
    publishDetail((published) => publish(published), detail, sessions, completion);
  return {
    created, scenario,
    confirm: (sessions = [created]) => confirmAs(created, sessions),
    confirmAs,
    expectPayload: (expected) => { mutation.expectPayload(expected); },
    finishPublished: (read, detail = created) => settleCommand(read, completion, detail),
    publish,
    rejectList: (message) => rejectCommand(list, completion, message),
    settleList: async (...details) => { list.resolveSummaries(...details); await completion; },
  };
}

export interface ReconciliationScenario {
  readonly controller: SessionController;
  completeCreationReconciliation(detail: AgentSessionDetail, sessions?: readonly AgentSessionDetail[]): Promise<void>;
  completeHydration(detail: AgentSessionDetail): Promise<void>;
  expectCommandCount(name: OperationName, count: number): void;
  expectCreationBlocked(prompt: string, draft?: Readonly<Record<string, unknown>>): void;
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
  publishSessionList(command: PendingSessionCommand, sessions: readonly AgentSessionDetail[]): Promise<PendingSessionCommand>;
  reconnect(): void;
  startHydration(): Promise<PendingSessionCommand>;
  startMutation(name: SessionMutationName): Promise<StartedSessionMutation>;
  startUnknownCreation(prompt: string, message?: string): Promise<UnknownCreationReconciliation>;
  takeRead(): Promise<PendingSessionCommand>;
}

function createReconciliationScenario(state: SessionViewState): ReconciliationScenario {
  const transport = createControlledSessionTransport();
  const controller = new SessionController(createReactiveState(state), undefined, null, transport);
  const takeSessionList = () => transport.take("subscribe");
  const scenario: ReconciliationScenario & { failLoadCommand(loading: Promise<void>, message: string): Promise<void> } = {
    controller,
  async completeCreationReconciliation(
    detail: AgentSessionDetail,
    sessions?: readonly AgentSessionDetail[],
  ): Promise<void> {
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

  async expectEventuallyCreatedSessionSelected(
    sessionId: string,
  ): Promise<void> {
    await vi.waitFor(() => {
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

  async expectEventuallyError(fragment: string): Promise<void> {
    await vi.waitFor(() => {
      scenario.expectError(fragment);
    });
  },

  expectEventuallyState(expected: StateMatch): Promise<void> {
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
    expect(controller.state.sessions?.map(({ id }) => id)).toEqual(
      expected,
    );
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

  async failLoadCommand(loading: Promise<void>, message: string): Promise<void> {
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
      scenario, completion, mutation, list, prompt,
    );
  },

  async takeRead(): Promise<PendingSessionCommand> {
    return transport.take("read");
  },
  };
  return scenario;
}

export function activeReconciliationScenario(): ReconciliationScenario {
  const running = sessionDetail({ status: "running" });
  return createReconciliationScenario(selectedState({ detail: running, sessions: [summaryFromDetail(running)] }));
}
export function creationReconciliationScenario(prompt = "Frozen creation", options: CreationScenarioOptions = {}): ReconciliationScenario {
  return createReconciliationScenario(creationState(prompt, options));
}
export function selectedReconciliationScenario(detail: AgentSessionDetail = sessionDetail()): ReconciliationScenario {
  return createReconciliationScenario(selectedState({ detail }));
}
export function unloadedCreationReconciliationScenario(): ReconciliationScenario {
  return creationReconciliationScenario("Frozen creation", { sessions: undefined });
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
  scenarios: Readonly<Record<string, ReconciliationTest>>,
): void {
  for (const [name, run] of Object.entries(scenarios)) {
    test(name, run);
  }
}
