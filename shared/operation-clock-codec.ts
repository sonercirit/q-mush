import type { HybridTimestamp } from "./operation-core.ts";
import { isRecord } from "./validation.ts";

export const decodeHybridTimestamp = (
  value: unknown,
  invalid: () => Error,
): HybridTimestamp => {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 3 ||
    !Object.hasOwn(value, "physicalMs") ||
    !Object.hasOwn(value, "logical") ||
    !Object.hasOwn(value, "writerId") ||
    !Number.isSafeInteger(value["physicalMs"]) ||
    Number(value["physicalMs"]) < 0 ||
    !Number.isSafeInteger(value["logical"]) ||
    Number(value["logical"]) < 0 ||
    typeof value["writerId"] !== "string"
  )
    throw invalid();
  return {
    physicalMs: Number(value["physicalMs"]),
    logical: Number(value["logical"]),
    writerId: value["writerId"],
  };
};
