import { expect } from "bun:test";

export function expectPkceParameters(
  authorizationUrl: URL,
  expectedChallenge: string,
): void {
  expect(authorizationUrl.searchParams.get("code_challenge")).toBe(
    expectedChallenge,
  );
  expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe(
    "S256",
  );
}

export function expectRedirect(response: Response, location: string): void {
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe(location);
}

export function takeValue<T>(values: T[], errorMessage: string): T {
  const value = values.shift();

  if (value === undefined) {
    throw new Error(errorMessage);
  }

  return value;
}
