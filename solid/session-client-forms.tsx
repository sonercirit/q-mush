import { type JSX } from "solid-js";
import type { AgentImage } from "../shared/agent-images.ts";
import { renderSessionImageInput } from "./session-image-client.tsx";

export function renderSessionPromptInput(options: {
  readonly disabled: boolean;
  readonly images: readonly AgentImage[];
  readonly prompt: string;
}): JSX.Element {
  return (
    <div class="lg:col-span-2">
      <label class="text-sm font-medium text-slate-200" for="session-prompt">
        Task
      </label>
      <textarea
        class="mt-2 min-h-28 w-full resize-y rounded-xl border border-white/10 bg-slate-900 px-4 py-3 text-sm leading-6 text-white placeholder:text-slate-600 focus:border-emerald-300/50 focus:outline-none"
        data-focus-key="session-prompt"
        disabled={options.disabled}
        id="session-prompt"
        name="prompt"
        placeholder="Describe the change you want the agent to make…"
      >
        {options.prompt}
      </textarea>
      <div class="mt-3">
        {renderSessionImageInput({
          action: "add-session-images",
          disabled: options.disabled,
          id: "session-images",
          images: options.images,
          removeAction: "remove-session-image",
        })}
      </div>
    </div>
  );
}

export function renderSessionFollowUp(options: {
  readonly images: readonly AgentImage[];
  readonly prompt: string;
  readonly sending: boolean;
}): JSX.Element {
  return (
    <form
      class="flex min-w-0 flex-1 flex-col gap-3"
      data-action="send-session-message"
    >
      <textarea
        class="min-h-20 w-full resize-y rounded-xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white placeholder:text-slate-600 focus:border-emerald-300/50 focus:outline-none"
        data-focus-key="session-follow-up"
        disabled={options.sending}
        name="prompt"
        placeholder="Give this session another instruction…"
      >
        {options.prompt}
      </textarea>
      {renderSessionImageInput({
        action: "add-follow-up-images",
        disabled: options.sending,
        id: "follow-up-images",
        images: options.images,
        removeAction: "remove-follow-up-image",
      })}
      <button
        class="self-end rounded-xl bg-cyan-300 px-4 py-3 text-sm font-semibold text-slate-950 disabled:opacity-50"
        disabled={options.sending}
        type="submit"
      >
        {options.sending ? "Sending…" : "Send"}
      </button>
    </form>
  );
}
