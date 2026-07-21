import type { AgentImage } from "./agent-images.ts";
import { createElement, type JsxNode } from "./jsx.ts";
import { renderSessionImageInput } from "./session-image-client.tsx";

export function renderSessionPromptInput(options: {
  readonly disabled: boolean;
  readonly images: readonly AgentImage[];
  readonly prompt: string;
}): JsxNode {
  return (
    <div className="lg:col-span-2">
      <label
        className="text-sm font-medium text-slate-200"
        htmlFor="session-prompt"
      >
        Task
      </label>
      <textarea
        className="mt-2 min-h-28 w-full resize-y rounded-xl border border-white/10 bg-slate-900 px-4 py-3 text-sm leading-6 text-white placeholder:text-slate-600 focus:border-emerald-300/50 focus:outline-none"
        disabled={options.disabled}
        id="session-prompt"
        name="prompt"
        placeholder="Describe the change you want the agent to make…"
      >
        {options.prompt}
      </textarea>
      <div className="mt-3">
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
}): JsxNode {
  return (
    <form
      className="flex min-w-0 flex-1 flex-col gap-3"
      data-action="send-session-message"
    >
      <textarea
        className="min-h-20 w-full resize-y rounded-xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white placeholder:text-slate-600 focus:border-emerald-300/50 focus:outline-none"
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
        className="self-end rounded-xl bg-cyan-300 px-4 py-3 text-sm font-semibold text-slate-950 disabled:opacity-50"
        disabled={options.sending}
        type="submit"
      >
        {options.sending ? "Sending…" : "Send"}
      </button>
    </form>
  );
}
