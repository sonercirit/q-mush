export function effectiveContextTokenLimit(
  modelLimit: number | null,
  userCap: number | null,
): number | null {
  if (modelLimit === null) return userCap;
  if (userCap === null) return modelLimit;
  return Math.min(modelLimit, userCap);
}

export function parseContextTokenCapInput(
  value: string,
): number | null | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (!/^\d+$/u.test(trimmed)) return undefined;
  const cap = Number(trimmed);
  return Number.isSafeInteger(cap) && cap > 0 ? cap : undefined;
}

export function contextTokenCapValidationError(
  userCap: number | null,
  modelLimit: number | null,
): string | undefined {
  if (userCap !== null && (!Number.isSafeInteger(userCap) || userCap <= 0)) {
    return "Context token cap must be a positive integer.";
  }
  if (userCap !== null && modelLimit !== null && userCap > modelLimit) {
    return `Context token cap cannot exceed the model limit of ${modelLimit.toLocaleString("en-US")} tokens.`;
  }
  return undefined;
}
