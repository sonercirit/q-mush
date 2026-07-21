import { agentImageDataUrl, type AgentImage } from "./agent-images.ts";
import { createElement, type JsxNode } from "./jsx.ts";
import { AGENT_IMAGE_ACCEPT } from "./session-image-input.ts";

interface SessionImageInputOptions {
  readonly action: "add-follow-up-images" | "add-session-images";
  readonly disabled: boolean;
  readonly id: string;
  readonly images: readonly AgentImage[];
  readonly removeAction: "remove-follow-up-image" | "remove-session-image";
}

export function renderSessionImagePreviews(
  images: readonly AgentImage[],
  removeAction?: SessionImageInputOptions["removeAction"],
  disabled = false,
): JsxNode {
  if (images.length === 0) {
    return null;
  }

  return (
    <ul className="flex flex-wrap gap-3" data-session-images="true">
      {images.map((image, index) => (
        <li className="relative w-28 rounded-xl border border-white/10 bg-slate-950/80 p-2">
          <img
            alt={image.name}
            className="h-20 w-full rounded-lg object-cover"
            src={agentImageDataUrl(image)}
          />
          <p className="mt-1 truncate text-xs text-slate-400">{image.name}</p>
          {removeAction === undefined ? null : (
            <button
              aria-label={`Remove ${image.name}`}
              className="absolute -right-2 -top-2 grid size-6 place-items-center rounded-full border border-white/10 bg-slate-900 text-xs text-slate-300 hover:text-rose-200 disabled:opacity-50"
              data-action={removeAction}
              data-image-index={index}
              disabled={disabled}
              type="button"
            >
              ×
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

export function renderSessionImageInput(
  options: SessionImageInputOptions,
): JsxNode {
  return (
    <div className="space-y-3">
      {renderSessionImagePreviews(
        options.images,
        options.removeAction,
        options.disabled,
      )}
      <label className="inline-flex cursor-pointer items-center rounded-xl border border-white/10 bg-slate-900 px-4 py-2.5 text-sm font-semibold text-slate-300 transition hover:border-cyan-300/30 hover:text-cyan-200 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50">
        Attach images
        <input
          accept={AGENT_IMAGE_ACCEPT}
          className="sr-only"
          data-action={options.action}
          disabled={options.disabled}
          id={options.id}
          multiple
          type="file"
        />
      </label>
      <p className="text-xs text-slate-500">
        Select or paste PNG, JPEG, GIF, or WebP images. Up to 8 images, 10 MB
        each.
      </p>
    </div>
  );
}
