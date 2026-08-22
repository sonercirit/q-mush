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

export class SessionPendingInputController {
  #activeAttempt: ActivePendingInputAttempt | undefined;
  readonly #options: PendingInputControllerOptions;

  constructor(options: PendingInputControllerOptions) {
    this.#options = options;
  }

  #sessionInput():
    | {
        readonly detail: NonNullable<SessionViewState["detail"]>;
        readonly sessionId: string;
        readonly state: SessionViewState;
      }
    | undefined {
    const state = this.#options.view.value;
    const detail = state.detail;
    const sessionId = state.selectedId;
    return sessionId !== undefined && detail?.id === sessionId
      ? { detail, sessionId, state }
      : undefined;
  }

  #startMutation(): number {
    const revision = this.#options.view.begin({
      error: undefined,
      sending: true,
    });
    this.#options.loader.noteMutationStarted();
    const sessionId = this.#options.view.value.selectedId;
    if (sessionId !== undefined) this.#options.realtime.rebaseStream(sessionId);
    return revision;
  }

  #finishMutation(): void {
    this.#options.loader.continueHydration();
  }

  #withoutAttempt(attempt: PendingInputAttempt) {
    return withoutOptimisticPendingInput(
      this.#options.view.value.optimisticPendingInputs,
      attempt.clientRequestId,
    );
  }

  reset(): void {
    this.#activeAttempt = undefined;
  }

  reconcile(detail: AgentSessionDetail): void {
    const active = this.#activeAttempt;
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
    if (this.#activeAttempt === active) {
      this.#activeAttempt = undefined;
    }
    this.#options.view.patchCurrent(active.revision, { sending: false });
    this.#finishMutation();
  }

  async cancel(inputId: string): Promise<void> {
    const selected = this.#sessionInput();
    if (
      this.#options.transport === undefined ||
      selected === undefined ||
      sessionMutationPending(selected.state) ||
      !selected.detail.pendingInputs.some((input) => input.id === inputId)
    ) {
      return;
    }
    const revision = this.#startMutation();
    try {
      const value = await this.#options.transport.command(
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
      if (input.id !== inputId || !this.#options.view.isCurrent(revision)) {
        return;
      }
      this.#applyAuthoritative(revision, authoritative, {
        followUp: input.content,
        followUpImages: input.images,
        sending: false,
      });
    } catch (error) {
      this.#options.view.patchCurrent(revision, {
        sending: false,
        error: sessionMutationError(
          normalizedSessionMutationError(error),
          "cancel that pending instruction",
        ),
      });
    } finally {
      this.#finishMutation();
    }
  }

  #applyAuthoritative(
    revision: number,
    detail: AgentSessionDetail,
    patch: Partial<SessionViewState>,
  ): void {
    this.#options.realtime.applyDetail(detail);
    this.#options.view.patchCurrent(revision, patch);
  }

  async #sendAttempt(
    attempt: PendingInputAttempt,
    restoreDraft: boolean,
  ): Promise<void> {
    const optimistic = optimisticPendingInput(attempt, Date.now());
    const revision = this.#startMutation();
    const active: ActivePendingInputAttempt = {
      attempt,
      confirm: undefined,
      confirmed: false,
      confirmedDetail: undefined,
      revision,
    };
    this.#activeAttempt = active;
    this.#options.view.patchCurrent(revision, {
      ...(restoreDraft ? {} : { followUp: "", followUpImages: [] }),
      optimisticPendingInputs: [...this.#withoutAttempt(attempt), optimistic],
    });
    try {
      const transport = this.#options.transport;
      if (transport === undefined) {
        return;
      }
      const pending = requestPendingInputWithTimeout(
        transport,
        attempt,
        this.#options.timer ?? DEFAULT_PENDING_INPUT_TIMER,
      );
      active.confirm = pending.confirm;
      if (active.confirmedDetail !== undefined) {
        pending.confirm(active.confirmedDetail);
      }
      const authoritative = readSessionDetail(await pending.result);
      if (this.#options.view.isCurrent(revision)) {
        this.#applyAuthoritative(revision, authoritative, {
          optimisticPendingInputs: this.#withoutAttempt(attempt),
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
      this.#options.view.patchCurrent(revision, {
        ...(outcomeUnknown
          ? {
              ...draft,
              optimisticPendingInputs:
                this.#options.view.value.optimisticPendingInputs.map((input) =>
                  input.clientRequestId === attempt.clientRequestId
                    ? { ...input, status: "unconfirmed" }
                    : input,
                ),
            }
          : {
              ...draft,
              optimisticPendingInputs: this.#withoutAttempt(attempt),
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
      if (this.#activeAttempt === active) {
        this.#activeAttempt = undefined;
      }
      this.#finishMutation();
    }
  }

  async retry(clientRequestId: string): Promise<void> {
    const selected = this.#sessionInput();
    const blocked =
      selected === undefined || sessionMutationPending(selected.state);
    if (blocked || this.#options.transport === undefined) {
      return;
    }
    const input = this.#options.view.value.optimisticPendingInputs.find(
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
    await this.#sendAttempt(
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

  async submit(kind: AgentSessionPendingInputKind): Promise<void> {
    const selected = this.#sessionInput();
    const state = selected?.state ?? this.#options.view.value;
    const prompt = state.followUp.trim();
    const images = state.followUpImages;
    if (
      this.#options.transport === undefined ||
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
    await this.#sendAttempt(attempt, false);
  }
}
