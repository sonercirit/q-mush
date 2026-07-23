import type { JSX } from "solid-js";
import { DirectoryPickerController } from "../directory-picker-controller.ts";
import { createReactiveState } from "../reactive-state.ts";
import { SessionPanel, type SessionViewState } from "../session-client.tsx";
import { SessionController } from "../session-controller.ts";
import type { SessionPanelResources } from "../session-panel-resources.ts";

export function sessionPanelTestView(
  options: SessionPanelResources & { readonly state: SessionViewState },
): JSX.Element {
  const controller = new SessionController(
    createReactiveState(options.state),
    new DirectoryPickerController(
      createReactiveState(options.state.directoryPicker),
    ),
  );
  return (
    <SessionPanel
      controller={controller}
      openAi={options.openAi}
      openRouter={options.openRouter}
      runners={options.runners}
    />
  );
}
