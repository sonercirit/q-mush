import { isRecord } from "../shared/auth-model.ts";
import type { AgentTokenUsageSummary } from "../shared/session-token-usage.ts";
import { readNonNegativeSafeInteger } from "../shared/validation.ts";

export function readTokenUsageSummary(
  value: unknown,
): AgentTokenUsageSummary | null | undefined {
  if (value === undefined) return null;
  if (!isRecord(value)) return undefined;
  const cacheWriteInputTokens = readNonNegativeSafeInteger(
    value["cacheWriteInputTokens"],
  );
  const cachedInputTokens = readNonNegativeSafeInteger(
    value["cachedInputTokens"],
  );
  const inputTokens = readNonNegativeSafeInteger(value["inputTokens"]);
  const outputTokens = readNonNegativeSafeInteger(value["outputTokens"]);
  const reportedStepCount = readNonNegativeSafeInteger(
    value["reportedStepCount"],
  );
  const stepCount = readNonNegativeSafeInteger(value["stepCount"]);
  return cacheWriteInputTokens === undefined ||
    cachedInputTokens === undefined ||
    inputTokens === undefined ||
    outputTokens === undefined ||
    reportedStepCount === undefined ||
    stepCount === undefined ||
    reportedStepCount > stepCount
    ? undefined
    : {
        cacheWriteInputTokens,
        cachedInputTokens,
        inputTokens,
        outputTokens,
        reportedStepCount,
        stepCount,
      };
}
