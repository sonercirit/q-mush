import { expect, vi } from "vitest";

import type { AgentSessionDetail } from "../../shared/session-model.ts";
import { SESSION_REALTIME_OPERATIONS } from "../../shared/user-realtime-protocol.ts";
import type { SessionViewState } from "../../solid/session-client.tsx";
import { initialSessionViewState } from "../../solid/session-state.ts";
import { summaryFromDetail } from "../../solid/session-summary-codec.ts";
import type { SessionCommandTransport } from "../../solid/session-transport.ts";
import type { ReconciliationScenario } from "./session-controller-reconciliation-fixtures.ts";
import { TEST_SESSION_DETAIL } from "./session-fixtures.ts";

import type {
  ControllerMutationName,
  Operation,
  OperationName,
  Payload,
  StateMatch,
} from "./session-controller-reconciliation-types.ts";

export const MUTATION_OPERATIONS: Readonly<
  Record<ControllerMutationName, OperationName>
> = {
  compact: "compact",
  continueSession: "continue",
  create: "create",
  send: "send",
  stop: "stop",
};

export interface CreationScenarioOptions {
  readonly draft?: Partial<SessionViewState["draft"]>;
  readonly sessions?: readonly AgentSessionDetail[] | undefined;
}

import {
  createdSessionDetail,
  sessionDetail,
} from "./session-controller-reconciliation-detail-fixtures.ts";
export {
  createdSessionDetail,
  sessionDetail,
  sessionUserMessage,
} from "./session-controller-reconciliation-detail-fixtures.ts";

export interface PendingSessionCommand {
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
    expectPayload: (expected) => {
      expect(payload).toMatchObject(expected);
    },
    reject: (message) => {
      rejectPromise(new Error(message));
    },
    resolve: resolvePromise,
    resolveDetail: (changes = {}) => {
      resolvePromise(sessionDetail(changes));
    },
    resolveSummaries: (...details) => {
      resolvePromise({ sessions: details.map(summaryFromDetail) });
    },
  };
}

export interface ControlledSessionTransport extends SessionCommandTransport {
  count(name: OperationName): number;
  expectCount(name: OperationName, count: number): void;
  reconnect(): void;
  take(name: OperationName): Promise<PendingSessionCommand>;
}

export function createControlledSessionTransport(): ControlledSessionTransport {
  const commands: PendingSessionCommand[] = [];
  const taken = new Map<OperationName, number>();
  let reconnectListener: (() => void) | undefined;
  const matching = (name: OperationName): readonly PendingSessionCommand[] => {
    const operation = SESSION_REALTIME_OPERATIONS[name];
    return commands.filter((command) => command.operation === operation);
  };
  return {
    command: (operation, payload) =>
      new Promise((resolve, reject) => {
        commands.push(
          createPendingSessionCommand(operation, payload, resolve, reject),
        );
      }),
    count: (name) => matching(name).length,
    expectCount: (name, count) => {
      expect(matching(name).length).toBe(count);
    },
    onReconnect: (listener) => {
      reconnectListener = listener;
      return () => {
        reconnectListener = undefined;
      };
    },
    reconnect: () => {
      reconnectListener?.();
    },
    take: async (name) => {
      const index = taken.get(name) ?? 0;
      await vi.waitFor(() => {
        expect(matching(name).length).toBeGreaterThan(index);
      });
      const command = matching(name)[index];
      if (command === undefined)
        throw new Error(`Missing ${SESSION_REALTIME_OPERATIONS[name]} command`);
      taken.set(name, index + 1);
      return command;
    },
  };
}

export function selectedState(
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

export function creationState(
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

export async function rejectCommand(
  command: PendingSessionCommand,
  completion: Promise<void>,
  message: string,
): Promise<void> {
  command.reject(message);
  await completion;
}

export function createdSelectionState(sessionId: string): StateMatch {
  return {
    creating: false,
    draft: { prompt: "" },
    selectedId: sessionId,
  };
}

export async function publishDetail(
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
export interface StartedSessionMutation extends PendingSessionAction {
  reconcile(changes: Partial<AgentSessionDetail>): Promise<void>;
  rejectUnknown(message?: string): Promise<DetailMutationReconciliation>;
}
export interface DetailMutationReconciliation extends PendingSessionAction {
  reject(message: string): Promise<void>;
}
function createPendingSessionAction(
  scenario: ReconciliationScenario,
  completion: Promise<void>,
  command: PendingSessionCommand,
) {
  return {
    command,
    completion,
    scenario,
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
export function createStartedSessionMutation(
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
    reconcile: async (changes) => {
      await (await rejectUnknown()).resolve(changes);
    },
  };
}
export interface UnknownCreationReconciliation {
  readonly created: AgentSessionDetail;
  readonly scenario: ReconciliationScenario;
  confirm(sessions?: readonly AgentSessionDetail[]): Promise<void>;
  confirmAs: (
    detail: AgentSessionDetail,
    sessions?: readonly AgentSessionDetail[],
  ) => Promise<void>;
  expectPayload(expected: object): void;
  finishPublished(
    read: PendingSessionCommand,
    detail?: AgentSessionDetail,
  ): Promise<void>;
  publish(
    sessions?: readonly AgentSessionDetail[],
  ): Promise<PendingSessionCommand>;
  rejectList(message: string): Promise<void>;
  settleList(...details: readonly AgentSessionDetail[]): Promise<void>;
}
export function createUnknownCreationReconciliation(
  scenario: ReconciliationScenario,
  completion: Promise<void>,
  mutation: PendingSessionCommand,
  list: PendingSessionCommand,
  prompt: string,
): UnknownCreationReconciliation {
  const created = createdSessionDetail(prompt);
  const publish = (sessions: readonly AgentSessionDetail[] = [created]) =>
    scenario.publishSessionList(list, sessions);
  const confirmAs = (
    detail: AgentSessionDetail,
    sessions: readonly AgentSessionDetail[] = [detail],
  ) =>
    publishDetail(
      (published) => publish(published),
      detail,
      sessions,
      completion,
    );
  return {
    created,
    scenario,
    confirm: (sessions = [created]) => confirmAs(created, sessions),
    confirmAs,
    expectPayload: (expected) => {
      mutation.expectPayload(expected);
    },
    finishPublished: (read, detail = created) =>
      settleCommand(read, completion, detail),
    publish,
    rejectList: (message) => rejectCommand(list, completion, message),
    settleList: async (...details) => {
      list.resolveSummaries(...details);
      await completion;
    },
  };
}
