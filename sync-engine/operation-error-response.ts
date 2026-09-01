import { isOperationProtocolError } from "../shared/operation-core.ts";
import { createApiError } from "./http.ts";

export const operationProtocolErrorResponse = (
  error: unknown,
): Response | undefined => {
  if (!isOperationProtocolError(error)) return undefined;
  return createApiError(
    "operation_failed",
    error.operationError === "capacity"
      ? 507
      : error.operationError === "conflict"
        ? 409
        : 400,
  );
};
