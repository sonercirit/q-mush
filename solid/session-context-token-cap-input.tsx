import type { JSX } from "solid-js";
import type { AgentModelOption } from "../shared/agent-configuration.ts";
import { renderFormField } from "./form-field.tsx";
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
      <input
        class="mt-2 min-w-0 w-full rounded-xl border border-white/10 bg-slate-900 px-4 py-3 text-sm text-white placeholder:text-slate-600 focus:border-emerald-300/50 focus:outline-none"
        disabled={props.disabled}
        id="session-context-token-cap"
        min="1"
        name="userContextTokenCap"
        onInput={(event) => {
          props.onInput(event.currentTarget.value);
        }}
        placeholder="Use the model limit"
        step="1"
        type="number"
        value={props.value}
      />
      <p class="mt-1 text-xs text-slate-500">
        {`Leave blank to use the model limit; ${modelLimitLabel()}.`}
      </p>
    </div>,
  );
}
