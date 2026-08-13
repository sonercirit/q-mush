import type { JSX } from "solid-js";
import type { AgentModelOption } from "../shared/agent-configuration.ts";
import { renderFormField } from "./form-field.tsx";
import { SessionDraftEchoInput } from "./session-client-forms.tsx";
import { formatTokenCount } from "./session-context-client.tsx";

export function SessionContextTokenCapInput(props: {
  readonly disabled: boolean;
  readonly model: AgentModelOption | undefined;
  readonly onInput: (value: string) => void;
  readonly value: string;
}): JSX.Element {
  const modelLimitLabel = (): string =>
    props.model?.contextWindow === null || props.model === undefined
      ? "the model limit is not reported"
      : `the model limit is ${formatTokenCount(props.model.contextWindow)} tokens`;
  return renderFormField(
    "session-context-token-cap",
    <>Context token cap (optional)</>,
    <div>
      <SessionDraftEchoInput
        disabled={props.disabled}
        id="session-context-token-cap"
        name="userContextTokenCap"
        numeric={true}
        onInput={props.onInput}
        placeholder="Use the model limit"
        value={props.value}
      />
      <p class="mt-1 text-xs text-slate-500">
        {`Leave blank to use the model limit; ${modelLimitLabel()}.`}
      </p>
    </div>,
  );
}
