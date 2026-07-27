import type { AuthenticatedUser } from "../shared/auth-model.ts";
import { createApiError } from "./http.ts";
import { parseRequiredJson } from "./json-request.ts";

export async function withParsedUserInput<Input>(
  request: Request,
  user: AuthenticatedUser,
  read: (value: unknown) => Input | undefined,
  action: (userId: string, input: Input) => Response,
): Promise<Response> {
  const input = await parseRequiredJson(request, read);
  return input instanceof Response ? input : action(user.id, input);
}

export function optionalResultResponse<Value>(
  value: Value | undefined,
  present: (value: Value) => Response,
  error: string,
  status: number,
): Response {
  return value === undefined ? createApiError(error, status) : present(value);
}
