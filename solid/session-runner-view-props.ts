import type { RunnerSummary } from "../shared/runner-model.ts";
import type { SessionViewState } from "./session-client.tsx";
import type { SessionController } from "./session-controller.ts";

export interface SessionRunnerViewProps {
  readonly controller: SessionController;
  readonly onOpenDirectoryPicker: () => void;
  readonly runners: readonly RunnerSummary[];
  readonly state: SessionViewState;
}
