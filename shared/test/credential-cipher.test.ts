import { Buffer } from "node:buffer";
import { expect, test } from "vitest";
import {
  createCredentialCipher,
  CredentialCipher,
} from "../../shared/credential-cipher.ts";

const API_KEY = "sk-or-v1-sensitive-api-key";
const CONTEXT = "user-id:credential-id";

test("encrypts credentials with authenticated context", () => {
  const cipher = new CredentialCipher(Buffer.alloc(32, 3), () =>
    Buffer.alloc(12, 5),
  );
  const encrypted = cipher.seal(API_KEY, CONTEXT);

  expect(encrypted.startsWith("v1.")).toBe(true);
  expect(encrypted).not.toContain(API_KEY);
  expect(cipher.open(encrypted, CONTEXT)).toBe(API_KEY);
  expect(() => cipher.open(encrypted, "another-user:credential-id")).toThrow();
  expect(() => cipher.open(`${encrypted}.extra`, CONTEXT)).toThrow("malformed");
});

test("requires a 32-byte base64url encryption key", () => {
  const braveKey = Buffer.alloc(32, 4).toString("base64url");

  expect(
    createCredentialCipher(braveKey, "BRAVE_SEARCH_CREDENTIAL_KEY"),
  ).toBeInstanceOf(CredentialCipher);
  expect(() =>
    createCredentialCipher("not-base64url!", "BRAVE_SEARCH_CREDENTIAL_KEY"),
  ).toThrow("BRAVE_SEARCH_CREDENTIAL_KEY must be a 32-byte base64url value");
});
