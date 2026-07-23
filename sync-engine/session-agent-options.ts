import type {
  AgentModelOption,
  AgentReasoningEffort,
} from "../shared/agent-configuration.ts";
import type { AgentSessionToolOption } from "../shared/agent-tools.ts";
import type {
  ProviderCredentialSummary,
  ProviderId,
} from "../shared/provider-credential-store.ts";
import type { RunnerSummary } from "../shared/runner-model.ts";

export const SESSION_OPTION_CATEGORIES = [
  "runners",
  "credentials",
  "models",
  "reasoning_efforts",
  "tools",
] as const;
type SessionOptionCategory = (typeof SESSION_OPTION_CATEGORIES)[number];

const SESSION_OPTIONS_PAGE_SIZE = 10;
export const MAXIMUM_SESSION_OPTIONS_SEARCH_LENGTH = 100;
const MAXIMUM_SESSION_OPTIONS_OUTPUT_CHARACTERS = 24_000;

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

type SessionToolOption = Omit<AgentSessionToolOption, never>;

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

export interface SessionOptionsSource {
  readonly credentials: readonly SessionCredentialOption[];
  readonly models: readonly AgentModelOption[];
  readonly reasoningEfforts: readonly AgentReasoningEffort[];
  readonly runners: readonly RunnerSummary[];
  readonly tools: readonly AgentSessionToolOption[];
}

const MAXIMUM_OPTION_TEXT_LENGTH = 500;
const MAXIMUM_OPTION_DESCRIPTION_LENGTH = 1_000;
const MAXIMUM_OPTION_MODALITIES = 20;

function boundedText(
  value: string,
  maximum = MAXIMUM_OPTION_TEXT_LENGTH,
): string {
  return value.slice(0, maximum);
}

function boundedModel(option: AgentModelOption): AgentModelOption {
  const boundedStrings = (
    values: readonly string[] | null,
  ): readonly string[] | null =>
    values
      ?.slice(0, MAXIMUM_OPTION_MODALITIES)
      .map((value) => boundedText(value)) ?? null;
  return {
    ...option,
    id: boundedText(option.id),
    inputModalities: boundedStrings(option.inputModalities),
    label: boundedText(option.label),
    outputModalities: boundedStrings(option.outputModalities),
    reasoningEfforts: option.reasoningEfforts.slice(
      0,
      MAXIMUM_OPTION_MODALITIES,
    ),
  };
}

function boundedCredential(
  option: SessionCredentialOption,
): SessionCredentialOption {
  return {
    ...option,
    accountId: option.accountId === null ? null : boundedText(option.accountId),
    id: boundedText(option.id),
    label: boundedText(option.label),
  };
}

function searchableText(option: SessionOption): string {
  return Object.values(option)
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLocaleLowerCase();
}

function optionsForCategory(
  input: GetSessionOptionsToolInput,
  source: SessionOptionsSource,
): readonly SessionOption[] {
  switch (input.category) {
    case "credentials":
      return source.credentials.map(boundedCredential);
    case "models":
      return source.models.map(boundedModel);
    case "reasoning_efforts":
      return source.reasoningEfforts.map((effort) => ({ effort }));
    case "runners":
      return source.runners.flatMap((runner): readonly SessionOption[] =>
        runner.status === "online"
          ? [
              {
                architecture:
                  runner.architecture === null
                    ? null
                    : boundedText(runner.architecture),
                id: boundedText(runner.id),
                isDefault: runner.isDefault,
                name: runner.name === null ? null : boundedText(runner.name),
                platform:
                  runner.platform === null
                    ? null
                    : boundedText(runner.platform),
                status: "online",
              },
            ]
          : [],
      );
    case "tools":
      return source.tools.map(({ description, kind, label, name }) => ({
        description: boundedText(
          description,
          MAXIMUM_OPTION_DESCRIPTION_LENGTH,
        ),
        kind,
        label: boundedText(label),
        name,
      }));
  }
}

export function sessionOptionsOutput(
  input: GetSessionOptionsToolInput,
  source: SessionOptionsSource,
): string {
  const query = input.search?.toLocaleLowerCase();
  const matching = optionsForCategory(input, source).filter(
    (option) => query === undefined || searchableText(option).includes(query),
  );
  const totalItems = matching.length;
  const totalPages = Math.ceil(totalItems / SESSION_OPTIONS_PAGE_SIZE);
  if (totalPages > 0 && input.page > totalPages) {
    throw new Error("The requested session options page is out of range");
  }
  const start = (input.page - 1) * SESSION_OPTIONS_PAGE_SIZE;
  const items = matching.slice(start, start + SESSION_OPTIONS_PAGE_SIZE);
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
    },
    null,
    2,
  );
  if (output.length > MAXIMUM_SESSION_OPTIONS_OUTPUT_CHARACTERS) {
    throw new Error("The bounded session options output is too large");
  }
  return output;
}
