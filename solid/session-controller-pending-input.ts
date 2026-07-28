import { isRecord } from "../shared/auth-model.ts";
import type { AgentSessionPendingInputKind } from "../shared/session-model.ts";
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
  requestPendingInput,
  samePendingInputAttempt,
  sessionCanQueuePendingInput,
  type PendingInputAttempt,
} from "./session-pending-input.ts";
import { sessionMutationPending } from "./session-pending.ts";
import type { SessionCommandTransport } from "./session-transport.ts";

interface PendingInputControllerOptions {
  readonly loader: SessionLoadController;
  readonly realtime: SessionRealtimeState;
  readonly transport: SessionCommandTransport | undefined;
  readonly view: RevisionState<SessionViewState>;
}

export class SessionPendingInputController {
  #attempt: PendingInputAttempt | undefined;
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
    return revision;
  }

  #finishMutation(): void {
    this.#options.loader.continueHydration();
  }

  reset(): void {
    this.#attempt = undefined;
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
      if (
        input.id !== inputId ||
        !this.#options.view.patchCurrent(revision, {
          followUp: input.content,
          followUpImages: input.images,
          sending: false,
        })
      ) {
        return;
      }
      this.#options.realtime.applyDetail(authoritative);
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
    const attempt =
      this.#attempt !== undefined &&
      samePendingInputAttempt(this.#attempt, requested)
        ? this.#attempt
        : { ...requested, clientRequestId: crypto.randomUUID() };
    this.#attempt = attempt;
    const revision = this.#startMutation();
    try {
      const authoritative = readSessionDetail(
        await requestPendingInput(this.#options.transport, attempt),
      );
      if (
        this.#options.view.patchCurrent(revision, {
          followUp: "",
          followUpImages: [],
          sending: false,
        })
      ) {
        this.#options.realtime.applyDetail(authoritative);
      }
      this.#attempt = undefined;
    } catch (error) {
      const normalized = normalizedSessionMutationError(error);
      if (!sessionMutationOutcomeIsUnknown(normalized)) {
        this.#attempt = undefined;
      }
      this.#options.view.patchCurrent(revision, {
        sending: false,
        error: sessionMutationError(
          normalized,
          kind === "steer" ? "steer that session" : "queue that follow-up",
        ),
      });
    } finally {
      this.#finishMutation();
    }
  }
}
