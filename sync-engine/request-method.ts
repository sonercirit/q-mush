import { createMethodNotAllowedResponse } from "./http.ts";

export function requireRequestMethod(
  request: Request,
  method: string,
): Response | undefined {
  return request.method === method
    ? undefined
    : createMethodNotAllowedResponse(method);
}
