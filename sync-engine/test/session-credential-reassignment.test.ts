import { describe, expect, test } from "vitest";
import type { AppDatabase } from "../../shared/database.ts";
import { SessionCredentialReassignmentEndpoints } from "../../sync-engine/session-credential-reassignment.ts";
import {
  createAuthenticatedTestContext,
  TEST_NOW,
} from "./authenticated-integration-test-helpers.ts";

function closeDatabase(database: AppDatabase): void {
  database.$client.close();
}

function endpoint(options: {
  readonly changed?: string[];
  readonly result?: { readonly migratedSessionCount: number } | undefined;
}) {
  const { auth, database } = createAuthenticatedTestContext();
  return {
    close: () => {
      closeDatabase(database);
    },
    endpoint: new SessionCredentialReassignmentEndpoints({
      auth,
      now: () => TEST_NOW,
      onChanged: (userId) => {
        options.changed?.push(userId);
      },
      provider: "openai",
      store: {
        reassign: () => options.result,
      },
    }),
  };
}

function request(
  body: BodyInit | null,
  contentType = "application/json",
  method = "POST",
  authenticated = true,
): Request {
  return new Request(
    "http://localhost:3000/api/openai/credentials/target/session-reassignment",
    {
      ...(body === null ? {} : { body }),
      headers: {
        ...(authenticated
          ? { cookie: "q_mush_session=authenticated-session" }
          : {}),
        ...(contentType.length === 0 ? {} : { "content-type": contentType }),
      },
      method,
    },
  );
}

function closeEndpoint(setup: ReturnType<typeof endpoint>): void {
  setup.close();
}

function changedEndpoint(count: number, changed: string[] = []) {
  return endpoint({ changed, result: { migratedSessionCount: count } });
}

function reassignTarget(
  endpoint: SessionCredentialReassignmentEndpoints,
): Promise<Response> {
  return endpoint.reassign(request("{}"), "target");
}

async function expectTargetResult(options: {
  readonly expected: Readonly<Record<string, unknown>>;
  readonly setup: ReturnType<typeof endpoint>;
  readonly status: number;
}): Promise<void> {
  const response = await reassignTarget(options.setup.endpoint);
  expect(response.status).toBe(options.status);
  await expectJson(response, options.expected);
}

async function expectJson(
  response: Response,
  expected: Readonly<Record<string, unknown>>,
): Promise<void> {
  expect(await response.json()).toEqual(expected);
}

describe("session credential reassignment endpoint", () => {
  test("requires authentication, POST, and an exact empty JSON object", async () => {
    const setup = endpoint({ result: { migratedSessionCount: 1 } });

    expect(
      (await setup.endpoint.reassign(request("{}", "", "GET"), "target"))
        .status,
    ).toBe(405);
    const methodResponse = await setup.endpoint.reassign(
      request("{}", "", "DELETE"),
      "target",
    );
    expect(methodResponse.status).toBe(405);
    expect(methodResponse.headers.get("allow")).toBe("POST");
    expect(
      (
        await setup.endpoint.reassign(
          request("{}", "application/json", "POST", false),
          "target",
        )
      ).status,
    ).toBe(401);

    for (const invalid of [
      request(null),
      request("", "application/json"),
      request("not-json"),
      request("[]"),
      request('{"provider":"openrouter"}'),
      request("{}", "text/plain"),
    ]) {
      const response = await setup.endpoint.reassign(invalid, "target");
      expect(response.status).toBe(400);
      await expectJson(response, { error: "invalid_request" });
    }
    setup.close();
  });

  test("returns a count and emits one aggregate refresh only after changes", async () => {
    const changed: string[] = [];
    const setup = changedEndpoint(3, changed);
    await expectTargetResult({
      expected: { migratedSessionCount: 3 },
      setup,
      status: 200,
    });
    expect(changed).toHaveLength(1);
    closeEndpoint(setup);

    const unchanged: string[] = [];
    const zeroSetup = changedEndpoint(0, unchanged);
    const zeroResponse = await reassignTarget(zeroSetup.endpoint);
    await expectJson(zeroResponse, { migratedSessionCount: 0 });
    expect(unchanged).toEqual([]);
    closeEndpoint(zeroSetup);
  });

  test("uses the same non-enumerating error for every unavailable target", async () => {
    const setup = endpoint({ result: undefined });
    await expectTargetResult({
      expected: { error: "not_found" },
      setup,
      status: 404,
    });
    closeEndpoint(setup);
  });
});
