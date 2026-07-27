import { createApiError, parseJsonRequest } from "./http.ts";

export async function parseRequiredJson<Input>(
  request: Request,
  read: (value: unknown) => Input | undefined,
): Promise<Input | Response> {
  const input = await parseJsonRequest(request, read);
  return input ?? createApiError("invalid_request", 400);
}
