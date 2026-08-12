import { type JSX } from "solid-js";
import { CustomSelect } from "./custom-select.tsx";
import type { SessionController } from "./session-controller.ts";
import type { NewSessionFormState } from "./session-new-form-state.ts";

export function SessionExecutionEnvironmentSelect(props: {
  readonly controller: SessionController;
  readonly state: NewSessionFormState;
}): JSX.Element {
  return (
    <CustomSelect
      disabled={props.state.creating}
      emptyLabel="Bare Metal"
      id="session-execution-environment"
      label="Execution environment"
      name="executionEnvironment"
      onChoose={(value) => {
        props.controller.chooseOption("executionEnvironment", value, [
          "bare_metal",
          "container",
        ]);
      }}
      onToggle={() => {
        props.controller.toggleSelect("executionEnvironment");
      }}
      open={props.state.openSelect === "executionEnvironment"}
      options={[
        {
          description: "Run directly with the runner account's permissions",
          label: "Bare Metal",
          value: "bare_metal",
        },
        {
          description:
            "Root in a disposable container (Arch Linux by default) with network access and the workspace mounted",
          label: "Container",
          value: "container",
        },
      ]}
      required
      selectedValue={props.state.draft.executionEnvironment}
    />
  );
}
