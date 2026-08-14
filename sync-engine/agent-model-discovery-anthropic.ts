import {
  AGENT_REASONING_EFFORTS,
  MAXIMUM_AGENT_MODEL_OPTIONS,
  type AgentModelOption,
  type AgentReasoningEffort,
} from "../shared/agent-configuration.ts";
import { isRecord } from "../shared/auth-model.ts";

// The Anthropic Models API publishes a capability tree with `supported`
// booleans at each leaf: `capabilities.effort.<level>.supported`,
// `capabilities.thinking.types.adaptive.supported`, and
// `capabilities.image_input`/`pdf_input`. Anthropic-compatible proxies may
// omit it; absent capabilities leave the option unchanged.
function capabilityRecord(
  value: unknown,
  ...path: readonly string[]
): Readonly<Record<string, unknown>> | undefined {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[key];
  }
  return isRecord(current) ? current : undefined;
}

function capabilitySupported(
  value: unknown,
  ...path: readonly string[]
): boolean {
  return capabilityRecord(value, ...path)?.["supported"] === true;
}

// Undefined means efforts are unknown (fallback-eligible), while an array —
// possibly empty — is authoritative. Effort is independent of thinking, so
// adaptive-incapable models can still offer levels; sessions persist the
// adaptive leaf separately and omit `thinking` for those requests.
interface AnthropicEffortCapabilities {
  readonly adaptiveThinking: boolean | null;
  readonly efforts: readonly AgentReasoningEffort[] | undefined;
}

function anthropicCapabilityEfforts(
  capabilities: unknown,
): AnthropicEffortCapabilities {
  const effort = capabilityRecord(capabilities, "effort");
  const thinking = capabilityRecord(capabilities, "thinking");
  const adaptive = capabilityRecord(thinking, "types")?.["adaptive"];
  const adaptiveThinking =
    thinking?.["supported"] === false
      ? false
      : adaptive === undefined
        ? null
        : isRecord(adaptive)
          ? adaptive["supported"] === true
            ? true
            : adaptive["supported"] === false
              ? false
              : null
          : typeof adaptive === "boolean"
            ? adaptive
            : null;
  if (effort === undefined) {
    return { adaptiveThinking, efforts: undefined };
  }
  if (effort["supported"] !== true) {
    return { adaptiveThinking, efforts: [] };
  }
  // The documented tree has no "none" leaf; skipping it defends against a
  // server publishing one, which would otherwise duplicate the prepended
  // level. Omitting both effort and thinking parameters is always valid.
  const efforts = AGENT_REASONING_EFFORTS.filter(
    (level) => level !== "none" && capabilitySupported(effort, level),
  );
  // Affirmed effort support without named levels reads as unknown, not none:
  // levels from a dual-format listing can safely fill the missing detail.
  return {
    adaptiveThinking,
    efforts: efforts.length === 0 ? undefined : ["none", ...efforts],
  };
}

// Modalities are derived only when the tree actually describes them: proxies
// reuse `capabilities` for other metadata (context_window) while publishing
// top-level `input_modalities`, and an unconditional ["text"] would clobber
// that already-supported shape.
function anthropicCapabilityModalities(
  capabilities: unknown,
): readonly string[] | null {
  const image = capabilityRecord(capabilities, "image_input");
  const pdf = capabilityRecord(capabilities, "pdf_input");
  if (image === undefined && pdf === undefined) {
    return null;
  }
  return [
    "text",
    ...(image?.["supported"] === true ? ["image"] : []),
    ...(pdf?.["supported"] === true ? ["pdf"] : []),
  ];
}

export interface AnthropicCapabilityOption {
  readonly effortsAuthoritative: boolean;
  readonly option: AgentModelOption;
}

export function withAnthropicCapabilities(
  option: AgentModelOption,
  entry: Readonly<Record<string, unknown>>,
): AnthropicCapabilityOption {
  const capabilities = entry["capabilities"];
  const { adaptiveThinking, efforts } =
    anthropicCapabilityEfforts(capabilities);
  const modalities = anthropicCapabilityModalities(capabilities);
  return {
    effortsAuthoritative: efforts !== undefined,
    option: {
      ...option,
      adaptiveThinking,
      ...(modalities === null ? {} : { inputModalities: modalities }),
      ...(efforts === undefined ? {} : { reasoningEfforts: efforts }),
    },
  };
}

// Anthropic Models pages with `has_more`/`last_id` (20-item default);
// request the documented 1000-item maximum. A page claiming more must
// carry a fresh nonempty cursor and items — never loop or truncate —
// within a default-page-size crawl budget derived from the shared option
// cap so the page and item bounds cannot desynchronize.
const ANTHROPIC_DEFAULT_PAGE_SIZE = 20;
const MAXIMUM_ANTHROPIC_CATALOG_PAGES = Math.ceil(
  MAXIMUM_AGENT_MODEL_OPTIONS / ANTHROPIC_DEFAULT_PAGE_SIZE,
);

export interface AnthropicModelListCrawl {
  readonly fetchJson: (url: URL) => Promise<unknown>;
  readonly listUrl: string;
  readonly pageError: (message: string) => Error;
  readonly readPage: (value: unknown) => readonly unknown[];
  readonly tooManyOptionsError: () => Error;
}

export async function readAnthropicModelList(
  crawl: AnthropicModelListCrawl,
): Promise<readonly unknown[]> {
  const items: unknown[] = [];
  const seenCursors = new Set<string>();
  let afterId: string | undefined;
  while (seenCursors.size < MAXIMUM_ANTHROPIC_CATALOG_PAGES) {
    const url = new URL(crawl.listUrl);
    url.searchParams.set("limit", "1000");
    if (afterId !== undefined) {
      url.searchParams.set("after_id", afterId);
    }
    const value = await crawl.fetchJson(url);
    const page = crawl.readPage(value);
    items.push(...page);
    if (items.length > MAXIMUM_AGENT_MODEL_OPTIONS) {
      throw crawl.tooManyOptionsError();
    }
    if (!isRecord(value) || value["has_more"] !== true) {
      return items;
    }
    const lastId = value["last_id"];
    if (
      typeof lastId !== "string" ||
      lastId.length === 0 ||
      seenCursors.has(lastId) ||
      page.length === 0
    ) {
      throw crawl.pageError(
        "The provider returned an inconsistent model catalog page",
      );
    }
    seenCursors.add(lastId);
    afterId = lastId;
  }
  // Pages were well-formed; the crawl budget ran out.
  throw crawl.tooManyOptionsError();
}
