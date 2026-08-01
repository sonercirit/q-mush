import {
  AGENT_REASONING_EFFORTS,
  MAXIMUM_AGENT_MODEL_OPTIONS,
  type AgentModelOption,
  type AgentReasoningEffort,
} from "../shared/agent-configuration.ts";
import type { AgentSessionToolOption } from "../shared/agent-tools.ts";
import {
  isProviderId,
  type ProviderCredentialSummary,
  type ProviderId,
} from "../shared/provider-credential-store.ts";
import type { RunnerSummary } from "../shared/runner-model.ts";
import { normalizeSearchText } from "../shared/search.ts";
import { utf8ByteLength, utf8Prefix } from "../shared/utf8.ts";

export const SESSION_OPTION_CATEGORIES = [
  "runners",
  "credentials",
  "models",
  "reasoning_efforts",
  "tools",
] as const;
type SessionOptionCategory = (typeof SESSION_OPTION_CATEGORIES)[number];

export const SESSION_OPTIONS_PAGE_SIZE = 10;
export const MAXIMUM_SESSION_OPTIONS_SEARCH_LENGTH = 100;
const MAXIMUM_SESSION_OPTIONS_OUTPUT_BYTES = 24_000;

export interface GetSessionOptionsToolInput {
  readonly category: SessionOptionCategory;
  readonly credentialId?: string;
  readonly page: number;
  readonly provider?: ProviderId;
  readonly search?: string;
}

interface SessionCredentialOption extends ProviderCredentialSummary {
  readonly provider: ProviderId;
}

type SessionToolOption = Omit<AgentSessionToolOption, "definition">;

type SessionOption =
  | {
      readonly architecture: string | null;
      readonly id: string;
      readonly isDefault: boolean;
      readonly name: string | null;
      readonly platform: string | null;
      readonly status: "online";
    }
  | SessionCredentialOption
  | AgentModelOption
  | { readonly effort: AgentReasoningEffort }
  | SessionToolOption;

export function sessionOptionsPageFilter(
  input: GetSessionOptionsToolInput,
): Readonly<{ search?: string }> {
  return input.search === undefined ? {} : { search: input.search };
}

export interface SessionOptionsSource {
  readonly credentials: readonly SessionCredentialOption[];
  readonly models: readonly AgentModelOption[];
  readonly page?: {
    readonly totalItems: number;
  };
  readonly reasoningEfforts: readonly AgentReasoningEffort[];
  readonly runners: readonly RunnerSummary[];
  readonly tools: readonly AgentSessionToolOption[];
}

const MAXIMUM_OPTION_TEXT_BYTES = 300;
const MAXIMUM_OPTION_DESCRIPTION_BYTES = 1_000;
const MAXIMUM_OPTION_MODALITIES = 5;
const MAXIMUM_OPTION_MODALITY_BYTES = 80;
const MAXIMUM_OPTION_PRICE_BYTES = 100;

interface BoundedOption<T> {
  readonly option: T;
  readonly truncated: boolean;
}

function boundedText(
  value: string,
  maximumBytes = MAXIMUM_OPTION_TEXT_BYTES,
): BoundedOption<string> {
  const option = utf8Prefix(value, maximumBytes);
  return { option, truncated: utf8ByteLength(option) < utf8ByteLength(value) };
}

function boundedNullableText(
  value: string | null,
): BoundedOption<string | null> {
  return value === null
    ? { option: null, truncated: false }
    : boundedText(value);
}

function boundedPrice(
  value: string | number | undefined,
): BoundedOption<string | number | undefined> {
  return typeof value === "string"
    ? boundedText(value, MAXIMUM_OPTION_PRICE_BYTES)
    : { option: value, truncated: false };
}

function boundedPricing(
  pricing: AgentModelOption["pricing"],
): BoundedOption<AgentModelOption["pricing"]> {
  if (pricing === null) {
    return { option: null, truncated: false };
  }
  const cacheWriteInput = boundedPrice(pricing.cacheWriteInput);
  const cachedInput = boundedPrice(pricing.cachedInput);
  const input = boundedPrice(pricing.input);
  const output = boundedPrice(pricing.output);
  return {
    option: {
      ...(cacheWriteInput.option === undefined
        ? {}
        : { cacheWriteInput: cacheWriteInput.option }),
      ...(cachedInput.option === undefined
        ? {}
        : { cachedInput: cachedInput.option }),
      ...(input.option === undefined ? {} : { input: input.option }),
      ...(output.option === undefined ? {} : { output: output.option }),
    },
    truncated:
      cacheWriteInput.truncated ||
      cachedInput.truncated ||
      input.truncated ||
      output.truncated,
  };
}

function boundedNamedFields(option: {
  readonly id: string;
  readonly label: string;
}): {
  readonly id: BoundedOption<string>;
  readonly label: BoundedOption<string>;
} {
  return { id: boundedText(option.id), label: boundedText(option.label) };
}

function boundedReasoningEfforts(
  efforts: readonly AgentReasoningEffort[],
): BoundedOption<readonly AgentReasoningEffort[]> {
  const selected = [...new Set(efforts)].slice(
    0,
    AGENT_REASONING_EFFORTS.length,
  );
  return { option: selected, truncated: selected.length < efforts.length };
}

function boundedModel(
  option: AgentModelOption,
): BoundedOption<AgentModelOption> {
  let truncated = false;
  const boundedStrings = (
    values: readonly string[] | null,
  ): readonly string[] | null => {
    if (values === null) {
      return null;
    }
    const selected = values.slice(0, MAXIMUM_OPTION_MODALITIES);
    truncated ||= selected.length < values.length;
    return selected.map((value) => {
      const bounded = boundedText(value, MAXIMUM_OPTION_MODALITY_BYTES);
      truncated ||= bounded.truncated;
      return bounded.option;
    });
  };
  const named = boundedNamedFields(option);
  const pricing = boundedPricing(option.pricing);
  const validContextWindow =
    option.contextWindow === null ||
    (Number.isSafeInteger(option.contextWindow) && option.contextWindow > 0);
  const reasoningEfforts = boundedReasoningEfforts(option.reasoningEfforts);
  truncated ||=
    named.id.truncated ||
    named.label.truncated ||
    pricing.truncated ||
    reasoningEfforts.truncated ||
    !validContextWindow;
  return {
    option: {
      contextWindow: validContextWindow ? option.contextWindow : null,
      ...(option.fallbackPrompt === undefined
        ? {}
        : { fallbackPrompt: option.fallbackPrompt }),
      id: named.id.option,
      inputModalities: boundedStrings(option.inputModalities),
      label: named.label.option,
      outputModalities: boundedStrings(option.outputModalities),
      pricing: pricing.option,
      reasoningEfforts: reasoningEfforts.option,
    },
    truncated,
  };
}

function boundedCredential(
  option: SessionCredentialOption,
): BoundedOption<SessionCredentialOption> {
  const accountId = boundedNullableText(option.accountId);
  const baseUrl =
    option.baseUrl === undefined
      ? { option: undefined, truncated: false }
      : boundedText(option.baseUrl);
  const named = boundedNamedFields(option);
  const validProvider = isProviderId(option.provider);
  return {
    option: {
      ...option,
      accountId: accountId.option,
      ...(baseUrl.option === undefined ? {} : { baseUrl: baseUrl.option }),
      id: named.id.option,
      label: named.label.option,
      provider: validProvider ? option.provider : "openai",
    },
    truncated:
      accountId.truncated ||
      baseUrl.truncated ||
      named.id.truncated ||
      named.label.truncated ||
      !validProvider,
  };
}

function normalizedValues(values: readonly (string | undefined)[]): string {
  return normalizeSearchText(
    values.filter((value): value is string => value !== undefined).join(" "),
  );
}

function boundedModelSearchText(option: AgentModelOption): string {
  const pricing = option.pricing;
  const boundedValues = (values: readonly string[] | null): readonly string[] =>
    (values ?? [])
      .slice(0, MAXIMUM_OPTION_MODALITIES)
      .map((value) => utf8Prefix(value, MAXIMUM_OPTION_MODALITY_BYTES));
  const boundedPrice = (
    value: string | number | undefined,
  ): string | undefined =>
    typeof value === "string"
      ? utf8Prefix(value, MAXIMUM_OPTION_PRICE_BYTES)
      : value?.toString();
  return normalizedValues([
    option.contextWindow?.toString(),
    utf8Prefix(option.id, MAXIMUM_OPTION_TEXT_BYTES),
    utf8Prefix(option.label, MAXIMUM_OPTION_TEXT_BYTES),
    ...boundedValues(option.inputModalities),
    ...boundedValues(option.outputModalities),
    ...[...new Set(option.reasoningEfforts)].slice(
      0,
      AGENT_REASONING_EFFORTS.length,
    ),
    boundedPrice(pricing?.cacheWriteInput),
    boundedPrice(pricing?.cachedInput),
    boundedPrice(pricing?.input),
    boundedPrice(pricing?.output),
  ]);
}

function searchableText(option: SessionOption): string {
  if ("contextWindow" in option) {
    return boundedModelSearchText(option);
  }
  if ("classification" in option) {
    return normalizedValues([
      option.classification,
      option.description,
      option.label,
      option.name,
    ]);
  }
  if ("effort" in option) {
    return normalizeSearchText(option.effort);
  }
  if ("provider" in option) {
    return normalizedValues([
      option.accountId ?? undefined,
      option.baseUrl,
      option.id,
      option.label,
      option.provider,
      option.source,
    ]);
  }
  return normalizedValues([
    option.architecture ?? undefined,
    option.id,
    option.name ?? undefined,
    option.platform ?? undefined,
    option.status,
  ]);
}

function optionsForCategory(
  input: GetSessionOptionsToolInput,
  source: SessionOptionsSource,
): readonly BoundedOption<SessionOption>[] {
  switch (input.category) {
    case "credentials":
      return source.credentials.map(boundedCredential);
    case "models":
      return source.models.map(boundedModel);
    case "reasoning_efforts":
      return source.reasoningEfforts.map((effort) => ({
        option: { effort },
        truncated: false,
      }));
    case "runners":
      return source.runners.flatMap(
        (runner): readonly BoundedOption<SessionOption>[] => {
          if (runner.status !== "online") {
            return [];
          }
          const architecture = boundedNullableText(runner.architecture);
          const id = boundedText(runner.id);
          const name = boundedNullableText(runner.name);
          const platform = boundedNullableText(runner.platform);
          return [
            {
              option: {
                architecture: architecture.option,
                id: id.option,
                isDefault: runner.isDefault,
                name: name.option,
                platform: platform.option,
                status: "online",
              },
              truncated:
                architecture.truncated ||
                id.truncated ||
                name.truncated ||
                platform.truncated,
            },
          ];
        },
      );
    case "tools":
      return source.tools.map(
        ({ classification, description, label, name }) => {
          const boundedDescription = boundedText(
            description,
            MAXIMUM_OPTION_DESCRIPTION_BYTES,
          );
          const boundedLabel = boundedText(label);
          return {
            option: {
              classification,
              description: boundedDescription.option,
              label: boundedLabel.option,
              name,
            },
            truncated: boundedDescription.truncated || boundedLabel.truncated,
          };
        },
      );
  }
}

interface MatchingPage {
  readonly matching: readonly BoundedOption<SessionOption>[];
  readonly totalItems: number;
}

function requestedPageStart(input: GetSessionOptionsToolInput): number {
  return (input.page - 1) * SESSION_OPTIONS_PAGE_SIZE;
}

function normalizedOptionQuery(
  input: GetSessionOptionsToolInput,
): string | undefined {
  return input.search === undefined
    ? undefined
    : normalizeSearchText(input.search);
}

function collectMatchingPage<T>(options: {
  readonly input: GetSessionOptionsToolInput;
  readonly items: readonly T[];
  readonly matches: (item: T) => boolean;
  readonly output: (item: T) => BoundedOption<SessionOption>;
}): MatchingPage {
  const matching: BoundedOption<SessionOption>[] = [];
  const start = requestedPageStart(options.input);
  let totalItems = 0;
  for (const item of options.items) {
    if (!options.matches(item)) {
      continue;
    }
    if (totalItems >= start && matching.length < SESSION_OPTIONS_PAGE_SIZE) {
      matching.push(options.output(item));
    }
    totalItems += 1;
  }
  return { matching, totalItems };
}

function modelMatchingPage(
  input: GetSessionOptionsToolInput,
  models: readonly AgentModelOption[],
): MatchingPage {
  const start = requestedPageStart(input);
  const query = normalizedOptionQuery(input);
  if (query === undefined) {
    return {
      matching: models
        .slice(start, start + SESSION_OPTIONS_PAGE_SIZE)
        .map(boundedModel),
      totalItems: models.length,
    };
  }

  return collectMatchingPage({
    input,
    items: models,
    matches: (model) => boundedModelSearchText(model).includes(query),
    output: boundedModel,
  });
}

function matchingPage(
  input: GetSessionOptionsToolInput,
  source: SessionOptionsSource,
): MatchingPage {
  if (input.category === "models") {
    return modelMatchingPage(input, source.models);
  }
  const options = optionsForCategory(input, source);
  const query = normalizedOptionQuery(input);
  if (query === undefined) {
    const start = requestedPageStart(input);
    return {
      matching: options.slice(start, start + SESSION_OPTIONS_PAGE_SIZE),
      totalItems: options.length,
    };
  }

  return collectMatchingPage({
    input,
    items: options,
    matches: (candidate) => searchableText(candidate.option).includes(query),
    output: (candidate) => candidate,
  });
}

export function sessionOptionsOutput(
  input: GetSessionOptionsToolInput,
  source: SessionOptionsSource,
): string {
  if (
    input.category === "models" &&
    source.models.length > MAXIMUM_AGENT_MODEL_OPTIONS
  ) {
    throw new Error("The provider model catalog has too many options");
  }
  const externallyPaged = source.page !== undefined;
  if (
    externallyPaged &&
    (!Number.isSafeInteger(source.page.totalItems) ||
      source.page.totalItems < 0)
  ) {
    throw new Error("The paginated session options total is invalid");
  }
  const page = externallyPaged
    ? {
        matching: optionsForCategory(input, source),
        totalItems: source.page.totalItems,
      }
    : matchingPage(input, source);
  const totalItems = page.totalItems;
  const totalPages = Math.ceil(totalItems / SESSION_OPTIONS_PAGE_SIZE);
  if (input.page > Math.max(1, totalPages)) {
    throw new Error("The requested session options page is out of range");
  }
  if (
    externallyPaged &&
    page.matching.length !==
      Math.max(
        0,
        Math.min(
          SESSION_OPTIONS_PAGE_SIZE,
          totalItems - (input.page - 1) * SESSION_OPTIONS_PAGE_SIZE,
        ),
      )
  ) {
    throw new Error("The paginated session options source is invalid");
  }
  const selected = page.matching;
  const items = selected.map(({ option }) => option);
  const sourceFields = selected.some(({ truncated }) => truncated);
  const output = JSON.stringify(
    {
      category: input.category,
      filters: {
        ...(input.credentialId === undefined
          ? {}
          : { credentialId: input.credentialId }),
        ...(input.provider === undefined ? {} : { provider: input.provider }),
        ...(input.search === undefined ? {} : { search: input.search }),
      },
      hasNext: input.page < totalPages,
      hasPrevious: input.page > 1,
      items,
      page: input.page,
      pageSize: SESSION_OPTIONS_PAGE_SIZE,
      totalItems,
      totalPages,
      truncated: sourceFields,
      truncation: { outputBytes: false, sourceFields },
    },
    null,
    2,
  );
  if (
    Buffer.byteLength(output, "utf8") > MAXIMUM_SESSION_OPTIONS_OUTPUT_BYTES
  ) {
    throw new Error("The bounded session options output is too large");
  }
  return output;
}
