import { isOperationProtocolError } from "../shared/operation-core.ts";
import { createApiError } from "./http.ts";

export const handleOperationProtocolError = (
  error: unknown,
  otherwise: () => Response,
): Response =>
  isOperationProtocolError(error)
    ? createApiError(
        "operation_failed",
        error.operationError === "capacity"
          ? 507
          : error.operationError === "conflict"
            ? 409
            : 400,
      )
    : otherwise();
