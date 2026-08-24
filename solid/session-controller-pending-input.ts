import { isRecord } from "../shared/auth-model.ts";
import type {
  AgentSessionDetail,
  AgentSessionPendingInputKind,
} from "../shared/session-model.ts";
import { SESSION_REALTIME_OPERATIONS } from "../shared/user-realtime-protocol.ts";
import type { RevisionState } from "./revision-state.ts";
import type { SessionViewState } from "./session-client.tsx";
import { readSessionDetail, readSessionPendingInput } from "./session-codec.ts";
import type { SessionLoadController } from "./session-controller-load.ts";
import type { SessionRealtimeState } from "./session-controller-state.ts";
import {
  normalizedSessionMutationError,
  sessionMutationError,
  sessionMutationOutcomeIsUnknown,
} from "./session-mutations.ts";
import {
  optimisticPendingInput,
  requestPendingInput,
  sessionCanQueuePendingInput,
  withoutOptimisticPendingInput,
  type PendingInputAttempt,
} from "./session-pending-input.ts";
import { sessionMutationPending } from "./session-pending.ts";
import type { SessionCommandTransport } from "./session-transport.ts";

const PENDING_INPUT_CONFIRMATION_TIMEOUT_MS = 30_000;

export interface PendingInputTimer {
  clearTimeout(timeout: number): void;
  setTimeout(callback: () => void, delay: number): number;
}

const DEFAULT_PENDING_INPUT_TIMER: PendingInputTimer = {
  clearTimeout: (timeout) => {
    clearTimeout(timeout);
  },
  setTimeout: (callback, delay) => Number(setTimeout(callback, delay)),
};

interface PendingInputRequest {
  readonly confirm: (detail: AgentSessionDetail) => void;
  readonly result: Promise<unknown>;
}

function unknownOutcomeError(): Error & { readonly code: string } {
  return Object.assign(new Error("outcome_unknown"), {
    code: "outcome_unknown",
  });
}

function requestPendingInputWithTimeout(
  transport: SessionCommandTransport,
  attempt: PendingInputAttempt,
  timer: PendingInputTimer,
): PendingInputRequest {
  let confirm: (detail: AgentSessionDetail) => void = () => undefined;
  const result = new Promise<unknown>((resolve, reject) => {
    let settled = false;
    const timeout = timer.setTimeout(() => {
      settle(() => {
        reject(unknownOutcomeError());
      });
    }, PENDING_INPUT_CONFIRMATION_TIMEOUT_MS);
    function settle(action: () => void): void {
      if (settled) {
        return;
      }
      settled = true;
      timer.clearTimeout(timeout);
      action();
    }
    confirm = (detail) => {
      settle(() => {
        resolve(detail);
      });
    };
    void requestPendingInput(transport, attempt).then(
      (value) => {
        settle(resolve.bind(undefined, value));
      },
      (error: unknown) => {
        const failure =
          error instanceof Error ? error : new Error(String(error));
        settle(reject.bind(undefined, failure));
      },
    );
  });
  return {
    confirm: (detail) => {
      confirm(detail);
    },
    result,
  };
}

interface PendingInputControllerOptions {
  readonly loader: SessionLoadController;
  readonly realtime: SessionRealtimeState;
  readonly timer?: PendingInputTimer;
  readonly transport: SessionCommandTransport | undefined;
  readonly view: RevisionState<SessionViewState>;
}

interface ActivePendingInputAttempt {
  readonly attempt: PendingInputAttempt;
  confirm: ((detail: AgentSessionDetail) => void) | undefined;
  confirmed: boolean;
  confirmedDetail: AgentSessionDetail | undefined;
  readonly revision: number;
}

export interface SessionPendingInputController {
  cancel(inputId: string): Promise<void>;
  reconcile(detail: AgentSessionDetail): void;
  reset(): void;
  retry(clientRequestId: string): Promise<void>;
  submit(kind: AgentSessionPendingInputKind): Promise<void>;
}

export function createSessionPendingInputController(
  options: PendingInputControllerOptions,
): SessionPendingInputController {
  let activeAttempt: ActivePendingInputAttempt | undefined;

  function sessionInput():
    | {
        readonly detail: NonNullable<SessionViewState["detail"]>;
        readonly sessionId: string;
        readonly state: SessionViewState;
      }
    | undefined {
    const state = options.view.value;
    const detail = state.detail;
    const sessionId = state.selectedId;
    return sessionId !== undefined && detail?.id === sessionId
      ? { detail, sessionId, state }
      : undefined;
  }

  function startMutation(): number {
    const revision = options.view.begin({
      error: undefined,
      sending: true,
    });
    options.loader.noteMutationStarted();
    const sessionId = options.view.value.selectedId;
    if (sessionId !== undefined) options.realtime.rebaseStream(sessionId);
    return revision;
  }

  function finishMutation(): void {
    options.loader.continueHydration();
  }

  function withoutAttempt(attempt: PendingInputAttempt) {
    return withoutOptimisticPendingInput(
      options.view.value.optimisticPendingInputs,
      attempt.clientRequestId,
    );
  }

  function reset(): void {
    activeAttempt = undefined;
  }

  function reconcile(detail: AgentSessionDetail): void {
    const active = activeAttempt;
    if (
      active?.attempt.sessionId !== detail.id ||
      !detail.pendingInputs.some(
        ({ clientRequestId }) =>
          clientRequestId === active.attempt.clientRequestId,
      )
    ) {
      return;
    }
    active.confirmed = true;
    active.confirmedDetail = detail;
    active.confirm?.(detail);
    if (activeAttempt === active) {
      activeAttempt = undefined;
    }
    options.view.patchCurrent(active.revision, { sending: false });
    finishMutation();
  }

  async function cancel(inputId: string): Promise<void> {
    const selected = sessionInput();
    if (
      options.transport === undefined ||
      selected === undefined ||
      sessionMutationPending(selected.state) ||
      !selected.detail.pendingInputs.some((input) => input.id === inputId)
    ) {
      return;
    }
    const revision = startMutation();
    try {
      const value = await options.transport.command(
        SESSION_REALTIME_OPERATIONS.cancelPendingInput,
        { inputId, sessionId: selected.sessionId },
        crypto.randomUUID(),
      );
      if (!isRecord(value)) {
        throw new Error(
          "The server returned invalid pending input cancellation",
        );
      }
      const authoritative = readSessionDetail(value["detail"]);
      const input = readSessionPendingInput(value["input"]);
      if (input.id !== inputId || !options.view.isCurrent(revision)) {
        return;
      }
      applyAuthoritative(revision, authoritative, {
        followUp: input.content,
        followUpImages: input.images,
        sending: false,
      });
    } catch (error) {
      options.view.patchCurrent(revision, {
        sending: false,
        error: sessionMutationError(
          normalizedSessionMutationError(error),
          "cancel that pending instruction",
        ),
      });
    } finally {
      finishMutation();
    }
  }

  function applyAuthoritative(
    revision: number,
    detail: AgentSessionDetail,
    patch: Partial<SessionViewState>,
  ): void {
    options.realtime.applyDetail(detail);
    options.view.patchCurrent(revision, patch);
  }

  async function sendAttempt(
    attempt: PendingInputAttempt,
    restoreDraft: boolean,
  ): Promise<void> {
    const optimistic = optimisticPendingInput(attempt, Date.now());
    const revision = startMutation();
    const active: ActivePendingInputAttempt = {
      attempt,
      confirm: undefined,
      confirmed: false,
      confirmedDetail: undefined,
      revision,
    };
    activeAttempt = active;
    options.view.patchCurrent(revision, {
      ...(restoreDraft ? {} : { followUp: "", followUpImages: [] }),
      optimisticPendingInputs: [...withoutAttempt(attempt), optimistic],
    });
    try {
      const transport = options.transport;
      if (transport === undefined) {
        return;
      }
      const pending = requestPendingInputWithTimeout(
        transport,
        attempt,
        options.timer ?? DEFAULT_PENDING_INPUT_TIMER,
      );
      active.confirm = pending.confirm;
      if (active.confirmedDetail !== undefined) {
        pending.confirm(active.confirmedDetail);
      }
      const authoritative = readSessionDetail(await pending.result);
      if (options.view.isCurrent(revision)) {
        applyAuthoritative(revision, authoritative, {
          optimisticPendingInputs: withoutAttempt(attempt),
          sending: false,
        });
      }
    } catch (error) {
      if (active.confirmed) {
        return;
      }
      const normalized = normalizedSessionMutationError(error);
      const outcomeUnknown = sessionMutationOutcomeIsUnknown(normalized);
      const draft = restoreDraft
        ? {}
        : { followUp: attempt.prompt, followUpImages: attempt.images };
      options.view.patchCurrent(revision, {
        ...(outcomeUnknown
          ? {
              ...draft,
              optimisticPendingInputs:
                options.view.value.optimisticPendingInputs.map((input) =>
                  input.clientRequestId === attempt.clientRequestId
                    ? { ...input, status: "unconfirmed" }
                    : input,
                ),
            }
          : {
              ...draft,
              optimisticPendingInputs: withoutAttempt(attempt),
            }),
        sending: false,
        error: sessionMutationError(
          normalized,
          attempt.kind === "steer"
            ? "steer that session"
            : "queue that follow-up",
        ),
      });
    } finally {
      if (activeAttempt === active) {
        activeAttempt = undefined;
      }
      finishMutation();
    }
  }

  async function retry(clientRequestId: string): Promise<void> {
    const selected = sessionInput();
    const blocked =
      selected === undefined || sessionMutationPending(selected.state);
    if (blocked || options.transport === undefined) {
      return;
    }
    const input = options.view.value.optimisticPendingInputs.find(
      (candidate) =>
        candidate.clientRequestId === clientRequestId &&
        candidate.status === "unconfirmed",
    );
    if (
      input?.sessionId !== selected.sessionId ||
      !sessionCanQueuePendingInput(selected.detail.status, input.kind)
    ) {
      return;
    }
    await sendAttempt(
      {
        clientRequestId: input.clientRequestId,
        images: input.images,
        kind: input.kind,
        prompt: input.content,
        sessionId: input.sessionId,
      },
      true,
    );
  }

  async function submit(kind: AgentSessionPendingInputKind): Promise<void> {
    const selected = sessionInput();
    const state = selected?.state ?? options.view.value;
    const prompt = state.followUp.trim();
    const images = state.followUpImages;
    if (
      options.transport === undefined ||
      selected === undefined ||
      selected.detail.runnerRequired ||
      sessionMutationPending(state) ||
      !sessionCanQueuePendingInput(selected.detail.status, kind) ||
      (prompt.length === 0 && images.length === 0)
    ) {
      return;
    }
    const requested = {
      images,
      kind,
      prompt,
      sessionId: selected.sessionId,
    };
    const attempt = {
      ...requested,
      clientRequestId: crypto.randomUUID(),
    };
    await sendAttempt(attempt, false);
  }

  return { cancel, reconcile, reset, retry, submit };
}
