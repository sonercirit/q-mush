import { readIdentifier } from "./session-request-helpers.ts";

export function requestSearchSelection(request: Request): {
  readonly credentialId: string | undefined;
  readonly search: URLSearchParams;
} {
  const search = new URL(request.url).searchParams;
  return { credentialId: readIdentifier(search.get("credentialId")), search };
}
