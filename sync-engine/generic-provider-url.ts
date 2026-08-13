import { readBoundedTrimmedString } from "../shared/validation.ts";

const MAXIMUM_GENERIC_PROVIDER_BASE_URL_LENGTH = 2_048;

function parseGenericProviderBaseUrl(value: unknown): URL | undefined {
  const candidate = readBoundedTrimmedString(
    value,
    MAXIMUM_GENERIC_PROVIDER_BASE_URL_LENGTH,
  );
  if (candidate === undefined) {
    return undefined;
  }

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return undefined;
  }
  const supportedProtocol = ["http:", "https:"].includes(url.protocol);
  const hasDisallowedComponents = [
    url.username,
    url.password,
    url.search,
    url.hash,
  ].some((component) => component.length > 0);
  if (!supportedProtocol || hasDisallowedComponents) {
    return undefined;
  }
  return url;
}

export function normalizeGenericProviderBaseUrl(
  value: unknown,
): string | undefined {
  const url = parseGenericProviderBaseUrl(value);
  if (url === undefined) {
    return undefined;
  }
  const pathname = url.pathname.replace(/\/+$/u, "");
  return `${url.origin}${pathname}`;
}

// The context-window beta only affects first-party models; proxies and
// gateways commonly reject unknown anthropic-beta names with a 400.
export function isOfficialAnthropicEndpoint(
  baseUrl: string | undefined,
): boolean {
  return parseGenericProviderBaseUrl(baseUrl)?.hostname === "api.anthropic.com";
}

export function genericProviderEndpoint(
  baseUrl: string | undefined,
  resource: "chat/completions" | "messages" | "models",
): string {
  const normalized = normalizeGenericProviderBaseUrl(baseUrl);
  if (normalized === undefined) {
    throw new Error("The generic provider base URL is invalid");
  }
  return `${normalized}/${resource}`;
}
