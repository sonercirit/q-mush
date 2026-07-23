import { isRecord } from "./auth-model.ts";

export type ProviderModelPricing = Readonly<
  Partial<
    Record<
      "cacheWriteInput" | "cachedInput" | "input" | "output",
      string | number
    >
  >
>;

function validPrice(value: unknown): value is string | number {
  return (
    (typeof value === "number" && Number.isFinite(value) && value >= 0) ||
    (typeof value === "string" && value.trim().length > 0)
  );
}

export function readProviderModelPricing(
  value: unknown,
): ProviderModelPricing | null | undefined {
  if (!isRecord(value)) {
    return value === null ? null : undefined;
  }

  const cacheWriteInput = value["cacheWriteInput"];
  const cachedInput = value["cachedInput"];
  const input = value["input"];
  const output = value["output"];
  if (
    (cacheWriteInput !== undefined && !validPrice(cacheWriteInput)) ||
    (cachedInput !== undefined && !validPrice(cachedInput)) ||
    (input !== undefined && !validPrice(input)) ||
    (output !== undefined && !validPrice(output))
  ) {
    return undefined;
  }
  return {
    ...(validPrice(cacheWriteInput) ? { cacheWriteInput } : {}),
    ...(validPrice(cachedInput) ? { cachedInput } : {}),
    ...(validPrice(input) ? { input } : {}),
    ...(validPrice(output) ? { output } : {}),
  };
}
