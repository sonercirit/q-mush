import type { AgentSessionPendingInputKind } from "../shared/session-model.ts";
import type { RevisionState } from "./revision-state.ts";
import type { SessionViewState } from "./session-client.tsx";
import { readSessionDetail } from "./session-codec.ts";
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

  reset(): void {
    this.#attempt = undefined;
  }

  async submit(kind: AgentSessionPendingInputKind): Promise<void> {
    const state = this.#options.view.value;
    const detail = state.detail;
    const sessionId = state.selectedId;
    const prompt = state.followUp.trim();
    const images = state.followUpImages;
    if (
      this.#options.transport === undefined ||
      sessionId === undefined ||
      detail?.id !== sessionId ||
      detail.runnerRequired ||
      sessionMutationPending(state) ||
      !sessionCanQueuePendingInput(detail.status, kind) ||
      (prompt.length === 0 && images.length === 0)
    ) {
      return;
    }
    const requested = { images, kind, prompt, sessionId };
    const attempt =
      this.#attempt !== undefined &&
      samePendingInputAttempt(this.#attempt, requested)
        ? this.#attempt
        : { ...requested, clientRequestId: crypto.randomUUID() };
    this.#attempt = attempt;
    const revision = this.#options.view.begin({
      error: undefined,
      sending: true,
    });
    this.#options.loader.noteMutationStarted();
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
      this.#options.loader.continueHydration();
    }
  }
}
