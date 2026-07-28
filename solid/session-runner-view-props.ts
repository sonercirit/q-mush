import type { RunnerSummary } from "../shared/runner-model.ts";
import type { SessionViewState } from "./session-client.tsx";
import type { SessionController } from "./session-controller.ts";
import type { SessionCredentialOption } from "./session-credential-option.ts";

export interface SessionRunnerViewProps {
  readonly controller: SessionController;
  readonly credentials: readonly SessionCredentialOption[];
  readonly onOpenDirectoryPicker: () => void;
  readonly runners: readonly RunnerSummary[];
  readonly state: SessionViewState;
}
