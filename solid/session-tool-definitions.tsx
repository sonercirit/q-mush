import type { JSX } from "solid-js";
import { renderDebugBoundary } from "./render-debug.tsx";
import { renderStructuredCode } from "./session-syntax.tsx";

export function ToolDefinitions(props: {
  readonly serializedTools: string;
}): JSX.Element {
  return (
    <li
      class="min-w-0 rounded-xl border border-cyan-300/20 bg-cyan-300/10 p-3 sm:p-4"
      {...renderDebugBoundary("tool-definitions", "Tool definitions")}
    >
      <p class="text-xs font-semibold tracking-wide text-cyan-200 uppercase">
        Tool definitions
      </p>
      <details class="mt-3">
        <summary class="cursor-pointer text-sm font-medium text-cyan-100 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-cyan-300">
          Show selected tool schemas
        </summary>
        <div class="mt-3">{renderStructuredCode(props.serializedTools)}</div>
      </details>
    </li>
  );
}
