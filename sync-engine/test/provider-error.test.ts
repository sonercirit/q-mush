import { describe, expect, test } from "vitest";
import { readProviderStreamError } from "../../sync-engine/provider-error.ts";

function expectTransient(event: Readonly<Record<string, unknown>>): void {
  expect(readProviderStreamError(event).transient).toBe(true);
}

function expectPermanent(error: Readonly<Record<string, unknown>>): void {
  expect(
    readProviderStreamError({ error, type: "response.failed" }).transient,
  ).toBe(false);
}

describe("provider stream error classification", () => {
  test("defaults unknown and missing error codes to retryable", () => {
    const events: readonly Readonly<Record<string, unknown>>[] = [
      {
        error: { code: "new_provider_failure", message: "Try again" },
        type: "response.failed",
      },
      {
        response: { id: "response-no-code", status: "failed" },
        type: "response.failed",
      },
      { message: "Connection lost", type: "error" },
    ];

    for (const event of events) {
      expectTransient(event);
    }
  });

  test("recognizes numeric-string and metadata transient codes", () => {
    const numeric = readProviderStreamError({
      error: { code: "503", message: "Provider unavailable" },
      type: "response.failed",
    });
    const metadata = {
      error: {
        message: "Upstream unavailable",
        metadata: { error_type: "provider_unavailable" },
      },
      type: "response.failed",
    };

    expect(numeric.transient).toBe(true);
    expect(numeric.message).toContain("code 503");
    expectTransient(metadata);
  });

  test("known permanent signals override unknown or transient ones", () => {
    const errors: readonly Readonly<Record<string, unknown>>[] = [
      {
        code: "policy_violation",
        metadata: { error_type: "provider_unavailable" },
      },
      {
        code: "new_provider_failure",
        type: "authentication_error",
      },
      {
        code: "new_provider_failure",
        metadata: { error_type: "unsupported_parameter" },
      },
    ];

    for (const error of errors) {
      expectPermanent(error);
    }
  });
});
