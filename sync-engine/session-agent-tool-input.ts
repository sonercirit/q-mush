import {
  isProviderId,
  type ProviderId,
} from "../shared/provider-credential-store.ts";
import {
  MAXIMUM_SESSION_OPTIONS_SEARCH_LENGTH,
  SESSION_OPTION_CATEGORIES,
  type GetSessionOptionsToolInput,
} from "./session-agent-options.ts";
import {
  DEFAULT_READ_SESSION_CATEGORIES,
  DEFAULT_READ_SESSION_LIMIT,
  MAXIMUM_READ_SESSION_LIMIT,
  READ_SESSION_CATEGORIES,
  type ReadSessionCategory,
  type ReadSessionToolInput,
} from "./session-agent-read.ts";

import { readIdentifier, readStringField } from "./session-request-helpers.ts";

export function hasOnlySessionToolArguments(
  arguments_: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
): boolean {
  return Object.keys(arguments_).every((key) => allowed.includes(key));
}

function readCategories(
  value: unknown,
): readonly ReadSessionCategory[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  const categories: ReadSessionCategory[] = [];
  const isCategory = (category: string): category is ReadSessionCategory =>
    READ_SESSION_CATEGORIES.some((candidate) => candidate === category);
  for (const category of value) {
    if (
      typeof category !== "string" ||
      !isCategory(category) ||
      categories.includes(category)
    ) {
      return undefined;
    }
    categories.push(category);
  }
  return categories;
}

export function readSessionToolInput(
  arguments_: Readonly<Record<string, unknown>>,
): ReadSessionToolInput {
  const categoriesValue = arguments_["categories"];
  const categories =
    categoriesValue === undefined
      ? DEFAULT_READ_SESSION_CATEGORIES
      : readCategories(categoriesValue);
  const limitValue = arguments_["limit"];
  const limit =
    limitValue === undefined ? DEFAULT_READ_SESSION_LIMIT : limitValue;
  const sessionId = readIdentifier(arguments_["sessionId"]);
  if (
    !hasOnlySessionToolArguments(arguments_, [
      "sessionId",
      "categories",
      "limit",
    ]) ||
    categories === undefined ||
    sessionId === undefined ||
    typeof limit !== "number" ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAXIMUM_READ_SESSION_LIMIT
  ) {
    throw new Error("The read_session arguments are invalid");
  }
  return { categories, limit, sessionId };
}

function optionCategory(
  value: unknown,
): GetSessionOptionsToolInput["category"] | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  return SESSION_OPTION_CATEGORIES.find((category) => category === value);
}

function modelFilters(
  category: GetSessionOptionsToolInput["category"] | undefined,
  credentialValue: unknown,
  providerValue: unknown,
):
  | { readonly credentialId?: string; readonly provider?: ProviderId }
  | undefined {
  if (category !== "models") {
    return credentialValue === undefined && providerValue === undefined
      ? {}
      : undefined;
  }
  const credentialId = readIdentifier(credentialValue);
  return credentialId !== undefined && isProviderId(providerValue)
    ? { credentialId, provider: providerValue }
    : undefined;
}

export function getSessionOptionsToolInput(
  arguments_: Readonly<Record<string, unknown>>,
): GetSessionOptionsToolInput {
  const category = optionCategory(arguments_["category"]);
  const filters = modelFilters(
    category,
    arguments_["credentialId"],
    arguments_["provider"],
  );
  const pageValue = arguments_["page"];
  const page = pageValue === undefined ? 1 : pageValue;
  const searchValue = arguments_["search"];
  const search =
    searchValue === undefined
      ? undefined
      : readStringField(
          arguments_,
          "search",
          MAXIMUM_SESSION_OPTIONS_SEARCH_LENGTH,
          { trim: true },
        );
  if (
    !hasOnlySessionToolArguments(arguments_, [
      "category",
      "credentialId",
      "page",
      "provider",
      "search",
    ]) ||
    category === undefined ||
    filters === undefined ||
    typeof page !== "number" ||
    !Number.isSafeInteger(page) ||
    page < 1 ||
    (searchValue !== undefined && search === undefined)
  ) {
    throw new Error("The get_session_options arguments are invalid");
  }
  return {
    category,
    ...filters,
    page,
    ...(search === undefined ? {} : { search }),
  };
}
