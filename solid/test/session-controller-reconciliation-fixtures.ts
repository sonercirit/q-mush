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

class PendingSessionCommand {
  readonly operation: Operation;
  readonly payload: Payload;
  readonly #reject: (error: unknown) => void;
  readonly #resolve: (value: unknown) => void;

  constructor(
    operation: Operation,
    payload: Payload,
    resolve: (value: unknown) => void,
    reject: (error: unknown) => void,
  ) {
    this.operation = operation;
    this.payload = payload;
    this.#reject = reject;
    this.#resolve = resolve;
  }

  expectPayload(expected: object): void {
    expect(this.payload).toMatchObject(expected);
  }

  reject(message: string): void {
    this.#reject(new Error(message));
  }

  resolve(value: unknown): void {
    this.#resolve(value);
  }

  resolveDetail(changes: Partial<AgentSessionDetail> = {}): void {
    this.resolve(sessionDetail(changes));
  }

  resolveSummaries(...details: readonly AgentSessionDetail[]): void {
    this.resolve({ sessions: details.map(summaryFromDetail) });
  }
}

class ControlledSessionTransport implements SessionCommandTransport {
  readonly #commands: PendingSessionCommand[] = [];
  readonly #taken = new Map<OperationName, number>();
  #reconnect: (() => void) | undefined;

  command: SessionCommandTransport["command"] = (operation, payload) =>
    new Promise((resolve, reject) => {
      this.#commands.push(
        new PendingSessionCommand(operation, payload, resolve, reject),
      );
    });

  count(name: OperationName): number {
    return this.#matching(name).length;
  }

  expectCount(name: OperationName, count: number): void {
    expect(this.count(name)).toBe(count);
  }

  #matching(name: OperationName): readonly PendingSessionCommand[] {
    const operation = SESSION_REALTIME_OPERATIONS[name];
    return this.#commands.filter((command) => command.operation === operation);
  }

  onReconnect(listener: () => void): () => void {
    this.#reconnect = listener;
    return () => {
      this.#reconnect = undefined;
    };
  }

  reconnect(): void {
    this.#reconnect?.();
  }

  async take(name: OperationName): Promise<PendingSessionCommand> {
    const index = this.#taken.get(name) ?? 0;
    await vi.waitFor(() => {
      expect(this.#matching(name).length).toBeGreaterThan(index);
    });
    const command = this.#matching(name)[index];
    if (command === undefined) {
      throw new Error(`Missing ${SESSION_REALTIME_OPERATIONS[name]} command`);
    }
    this.#taken.set(name, index + 1);
    return command;
  }
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

class PendingSessionAction {
  readonly command: PendingSessionCommand;
  readonly completion: Promise<void>;
  readonly scenario: ReconciliationScenario;

  constructor(
    scenario: ReconciliationScenario,
    completion: Promise<void>,
    command: PendingSessionCommand,
  ) {
    this.scenario = scenario;
    this.completion = completion;
    this.command = command;
  }

  resolve(changes: Partial<AgentSessionDetail>): Promise<void> {
    return settleCommand(this.command, this.completion, sessionDetail(changes));
  }
}

class StartedSessionMutation extends PendingSessionAction {
  async reconcile(changes: Partial<AgentSessionDetail>): Promise<void> {
    const reconciliation = await this.rejectUnknown();
    await reconciliation.resolve(changes);
  }

  async rejectUnknown(
    message = "outcome_unknown",
  ): Promise<DetailMutationReconciliation> {
    this.command.reject(message);
    const read = await this.scenario.takeRead();
    return new DetailMutationReconciliation(
      this.scenario,
      this.completion,
      read,
    );
  }
}

class DetailMutationReconciliation extends PendingSessionAction {
  reject(message: string): Promise<void> {
    return rejectCommand(this.command, this.completion, message);
  }
}

class UnknownCreationReconciliation {
  readonly #completion: Promise<void>;
  readonly #list: PendingSessionCommand;
  readonly #mutation: PendingSessionCommand;
  readonly created: AgentSessionDetail;
  readonly scenario: ReconciliationScenario;

  constructor(
    scenario: ReconciliationScenario,
    completion: Promise<void>,
    mutation: PendingSessionCommand,
    list: PendingSessionCommand,
    prompt: string,
  ) {
    this.scenario = scenario;
    this.#completion = completion;
    this.#list = list;
    this.#mutation = mutation;
    this.created = createdSessionDetail(prompt);
  }

  confirm(
    sessions: readonly AgentSessionDetail[] = [this.created],
  ): Promise<void> {
    return this.confirmAs(this.created, sessions);
  }

  confirmAs(
    detail: AgentSessionDetail,
    sessions: readonly AgentSessionDetail[] = [detail],
  ): Promise<void> {
    return publishDetail(
      (published) => this.publish(published),
      detail,
      sessions,
      this.#completion,
    );
  }

  expectPayload(expected: object): void {
    this.#mutation.expectPayload(expected);
  }

  finishPublished(
    read: PendingSessionCommand,
    detail: AgentSessionDetail = this.created,
  ): Promise<void> {
    return settleCommand(read, this.#completion, detail);
  }

  publish(
    sessions: readonly AgentSessionDetail[] = [this.created],
  ): Promise<PendingSessionCommand> {
    return this.scenario.publishSessionList(this.#list, sessions);
  }

  rejectList(message: string): Promise<void> {
    return rejectCommand(this.#list, this.#completion, message);
  }

  async settleList(...details: readonly AgentSessionDetail[]): Promise<void> {
    this.#list.resolveSummaries(...details);
    await this.#completion;
  }
}

export class ReconciliationScenario {
  readonly controller: SessionController;
  readonly #transport: ControlledSessionTransport;

  private constructor(state: SessionViewState) {
    this.#transport = new ControlledSessionTransport();
    this.controller = new SessionController(
      createReactiveState(state),
      undefined,
      null,
      this.#transport,
    );
  }

  static active(): ReconciliationScenario {
    const running = sessionDetail({ status: "running" });
    return new ReconciliationScenario(
      selectedState({
        detail: running,
        sessions: [summaryFromDetail(running)],
      }),
    );
  }

  static creation(
    prompt = "Frozen creation",
    options: CreationScenarioOptions = {},
  ): ReconciliationScenario {
    return new ReconciliationScenario(creationState(prompt, options));
  }

  static selected(
    detail: AgentSessionDetail = sessionDetail(),
  ): ReconciliationScenario {
    return new ReconciliationScenario(selectedState({ detail }));
  }

  static unloadedCreation(): ReconciliationScenario {
    return ReconciliationScenario.creation("Frozen creation", {
      sessions: undefined,
    });
  }

  async completeCreationReconciliation(
    detail: AgentSessionDetail,
    sessions?: readonly AgentSessionDetail[],
  ): Promise<void> {
    const list = await this.#takeSessionList();
    await publishDetail(
      (published) => this.publishSessionList(list, published),
      detail,
      sessions ?? [detail],
    );
  }

  async completeHydration(detail: AgentSessionDetail): Promise<void> {
    const list = await this.#takeSessionList();
    list.resolveSummaries(detail);
    const read = await this.#transport.take("read");
    read.resolve(detail);
    await this.expectEventuallyState({ detail: { title: detail.title } });
  }

  expectCommandCount(name: OperationName, count: number): void {
    this.#transport.expectCount(name, count);
  }

  expectCreationBlocked(
    prompt: string,
    draft: Readonly<Record<string, unknown>> = {},
  ): void {
    this.expectState({
      creating: true,
      draft: { ...draft, prompt },
      sessions: [],
    });
  }

  expectCreatedSessionSelected(sessionId: string): void {
    this.expectState(createdSelectionState(sessionId));
  }

  async expectEventuallyCreatedSessionSelected(
    sessionId: string,
  ): Promise<void> {
    await vi.waitFor(() => {
      this.expectCreatedSessionSelected(sessionId);
    });
  }

  expectDetailSnapshotIgnored(title: string): void {
    this.controller.applyDetail(sessionDetail({ title }));
    expect(this.controller.state.detail?.title).not.toBe(title);
  }

  expectError(fragment: string): void {
    expect(this.controller.state.error).toContain(fragment);
  }

  async expectEventuallyError(fragment: string): Promise<void> {
    await vi.waitFor(() => {
      this.expectError(fragment);
    });
  }

  expectEventuallyState(expected: StateMatch): Promise<void> {
    return vi.waitFor(() => {
      this.expectState(expected);
    });
  }

  expectListTitleNot(title: string): void {
    expect(this.controller.state.sessions?.[0]?.title).not.toBe(title);
  }

  async expectMutationBlocked(name: ControllerMutationName): Promise<void> {
    const count = this.#transport.count(MUTATION_OPERATIONS[name]);
    await this.controller[name]();
    this.expectCommandCount(MUTATION_OPERATIONS[name], count);
  }

  expectPending(flag: PendingFlag, expected = true): void {
    expect(this.controller.state[flag]).toBe(expected);
  }

  expectSessionIds(expected: readonly string[]): void {
    expect(this.controller.state.sessions?.map(({ id }) => id)).toEqual(
      expected,
    );
  }

  expectSnapshotsIgnored(listTitle: string, detailTitle: string): void {
    this.controller.applyRealtime([
      summaryFromDetail(sessionDetail({ title: listTitle })),
    ]);
    this.expectDetailSnapshotIgnored(detailTitle);
    this.expectListTitleNot(listTitle);
  }

  expectState(expected: StateMatch): void {
    expect(this.controller.state).toMatchObject(expected);
  }

  failInitialLoad(message: string): Promise<void> {
    return this.#failLoad(this.controller.load(), message);
  }

  async #failLoad(loading: Promise<void>, message: string): Promise<void> {
    const list = await this.#takeSessionList();
    await rejectCommand(list, loading, message);
  }

  #takeSessionList(): Promise<PendingSessionCommand> {
    return this.#transport.take("subscribe");
  }

  async pauseForUnexpectedRetry(): Promise<void> {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }

  async publishSessionList(
    command: PendingSessionCommand,
    sessions: readonly AgentSessionDetail[],
  ): Promise<PendingSessionCommand> {
    command.resolveSummaries(...sessions);
    return this.#transport.take("read");
  }

  reconnect(): void {
    this.#transport.reconnect();
  }

  async startHydration(): Promise<PendingSessionCommand> {
    this.reconnect();
    return this.#transport.take("subscribe");
  }

  async startMutation(
    name: SessionMutationName,
  ): Promise<StartedSessionMutation> {
    const completion = this.controller[name]();
    const command = await this.#transport.take(MUTATION_OPERATIONS[name]);
    return new StartedSessionMutation(this, completion, command);
  }

  async startUnknownCreation(
    prompt: string,
    message = "outcome_unknown",
  ): Promise<UnknownCreationReconciliation> {
    const completion = this.controller.create();
    const mutation = await this.#transport.take("create");
    mutation.reject(message);
    const list = await this.#transport.take("subscribe");
    return new UnknownCreationReconciliation(
      this,
      completion,
      mutation,
      list,
      prompt,
    );
  }

  async takeRead(): Promise<PendingSessionCommand> {
    return this.#transport.take("read");
  }
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
  const scenario = ReconciliationScenario.active();
  return { mutation: await scenario.startMutation(action), scenario };
}

export async function uncertainCreationScenario(
  prompt = "Frozen creation",
  options: CreationScenarioOptions = {},
): Promise<UnknownCreationReconciliation> {
  const scenario = ReconciliationScenario.creation(prompt, options);
  return scenario.startUnknownCreation(prompt);
}

export async function startedHydrationScenario(): Promise<StartedHydration> {
  const scenario = ReconciliationScenario.active();
  return { list: await scenario.startHydration(), scenario };
}

export async function expectCompletedGenerationReconciliation(
  action: "compact" | "continueSession",
  pending: "compacting" | "sending",
): Promise<void> {
  const scenario = ReconciliationScenario.selected();
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
