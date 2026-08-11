import { readBoundedTrimmedString } from "../shared/validation.ts";

const MAXIMUM_GENERIC_PROVIDER_BASE_URL_LENGTH = 2_048;

export function normalizeGenericProviderBaseUrl(
  value: unknown,
): string | undefined {
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

  const pathname = url.pathname.replace(/\/+$/u, "");
  return `${url.origin}${pathname}`;
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
