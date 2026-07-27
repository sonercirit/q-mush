import { isRecord, readNullableString } from "./validation.ts";

export interface AuthenticatedUser {
  readonly email: string;
  readonly id: string;
  readonly name: string;
  readonly picture?: string;
}

export interface AuthSession {
  readonly googleLoginAvailable: boolean;
  readonly user: AuthenticatedUser | null;
}

export function readRequiredArray(
  value: unknown,
  key: string,
  errorMessage: string,
): readonly unknown[] {
  const items = isRecord(value) ? value[key] : undefined;

  if (!Array.isArray(items)) {
    throw new Error(errorMessage);
  }

  return items;
}

export { isRecord, readNullableString };
