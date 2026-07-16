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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
