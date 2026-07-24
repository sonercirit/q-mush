import type { ProviderCredentialAccess } from "../../shared/provider-credential-store.ts";

export function takeResponse(responses: Response[]): Response {
  const response = responses.shift();
  if (response === undefined) {
    throw new Error("The test ran out of provider responses");
  }
  return response;
}

export function testApiKeyCredential(
  secret: string,
): Pick<ProviderCredentialAccess, "accountId" | "secret" | "source"> {
  return { accountId: null, secret, source: "api_key" };
}

export function jsonResponseQueueFetch(
  bodies: unknown[],
  responses: Response[],
): (request: Request) => Promise<Response> {
  return async (request) => {
    bodies.push(await request.json());
    return takeResponse(responses);
  };
}
