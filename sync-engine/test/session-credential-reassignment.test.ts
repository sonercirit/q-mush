import { afterEach, describe, expect, test, vi } from "vitest";
import type { AppDatabase } from "../../shared/database.ts";
import { SessionCredentialReassignmentEndpoints } from "../session-credential-reassignment.ts";
import {
  createAuthenticatedTestContext,
  TEST_NOW,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";
import { closeTrackedDatabases } from "./database-test-helpers.ts";
import { testSessionCredentialMetadataUpdate } from "./session-credential-metadata-fixtures.ts";
import { expectErrorResponse } from "./session-reassignment-race-helpers.ts";

type ReassignmentEndpointOptions = Omit<
  ConstructorParameters<typeof SessionCredentialReassignmentEndpoints>[0],
  "auth" | "now"
>;

function reassignmentEndpoints(
  context: ReturnType<typeof createAuthenticatedTestContext>,
  options: ReassignmentEndpointOptions,
): SessionCredentialReassignmentEndpoints {
  return new SessionCredentialReassignmentEndpoints({
    auth: context.auth,
    now: () => TEST_NOW,
    ...options,
  });
}

function openRouterReassignmentEndpoint(
  context: ReturnType<typeof createAuthenticatedTestContext>,
  store: ReassignmentEndpointOptions["store"],
  overrides: Omit<ReassignmentEndpointOptions, "provider" | "store"> = {},
) {
  return reassignmentEndpoints(context, {
    ...overrides,
    provider: "openrouter",
    store,
  });
}

function setup(result: { readonly migratedSessionCount: number } | undefined) {
  const context = createAuthenticatedTestContext();
  const changed = vi.fn();
  const reassign = vi.fn(() => result);
  const endpoints = reassignmentEndpoints(context, {
    onChanged: changed,
    provider: "openai",
    store: { reassign },
  });
  return { ...context, changed, endpoints, reassign };
}

function request(
  body: string | null = "{}",
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
        "content-type": "application/json",
      },
      method,
    },
  );
}

const databases: AppDatabase[] = [];

type ProviderStatePreparation = NonNullable<
  ConstructorParameters<
    typeof SessionCredentialReassignmentEndpoints
  >[0]["prepareProviderState"]
>;

function trackedAuthenticatedTestContext() {
  const context = createAuthenticatedTestContext();
  databases.push(context.database);
  return context;
}

function closeFixtureDatabase(
  fixture: Readonly<{ database: AppDatabase }>,
): void {
  databases.push(fixture.database);
}

function trackedReassign() {
  return {
    context: trackedAuthenticatedTestContext(),
    reassign: vi.fn(() => ({ migratedSessionCount: 1 })),
  };
}

function trackedOpenRouterReassignmentEndpoint(
  snapshot: NonNullable<
    NonNullable<ReassignmentEndpointOptions["store"]>["snapshot"]
  >,
  prepareProviderState: ProviderStatePreparation,
) {
  const { context, reassign } = trackedReassign();
  return {
    endpoints: openRouterReassignmentEndpoint(
      context,
      { reassign, snapshot },
      { prepareProviderState },
    ),
    reassign,
  };
}

function validationSetup(prepareProviderState: ProviderStatePreparation) {
  return trackedOpenRouterReassignmentEndpoint(
    () => ({ sessions: [] }),
    prepareProviderState,
  );
}

async function reassignTarget(
  endpoints: SessionCredentialReassignmentEndpoints,
): Promise<Response> {
  return endpoints.reassign(request(), "target");
}

async function expectValidationFailure(
  prepareProviderState: ProviderStatePreparation,
  expectedStatus: number,
  expectedError: string,
): Promise<void> {
  const { endpoints, reassign } = validationSetup(prepareProviderState);
  const response = await reassignTarget(endpoints);
  await expectErrorResponse(response, expectedStatus, expectedError);
  expect(reassign).not.toHaveBeenCalled();
}

afterEach(() => {
  closeTrackedDatabases(databases);
});

describe("session credential reassignment endpoint", () => {
  test("requires explicit authenticated POST confirmation", async () => {
    const fixture = setup({ migratedSessionCount: 1 });
    closeFixtureDatabase(fixture);

    expect(
      (await fixture.endpoints.reassign(request("{}", "GET"), "target")).status,
    ).toBe(405);
    expect(
      (await fixture.endpoints.reassign(request("{}", "POST", false), "target"))
        .status,
    ).toBe(401);
    for (const invalid of [null, "", "[]", '{"provider":"openrouter"}']) {
      const response = await fixture.endpoints.reassign(
        request(invalid),
        "target",
      );
      expect(response.status).toBe(400);
    }
    expect(fixture.reassign).not.toHaveBeenCalled();
  });

  test("returns the exact count and publishes only after a change", async () => {
    const fixture = setup({ migratedSessionCount: 3 });
    closeFixtureDatabase(fixture);

    const response = await fixture.endpoints.reassign(request(), "target");
    expect(await response.json()).toEqual({ migratedSessionCount: 3 });
    expect(fixture.reassign).toHaveBeenCalledWith({
      credentialId: "target",
      now: TEST_NOW,
      provider: "openai",
      userId: TEST_USER_ID,
    });
    expect(fixture.changed).toHaveBeenCalledOnce();
    expect(fixture.changed).toHaveBeenCalledWith(TEST_USER_ID);
  });

  test("supports a workspace scope hook without trusting an unavailable scope", async () => {
    const { context, reassign } = trackedReassign();
    reassign.mockReturnValue({ migratedSessionCount: 0 });
    const endpoints = openRouterReassignmentEndpoint(
      context,
      { reassign },
      { scope: () => ({ workspaceId: "workspace-1" }) },
    );

    const emptyBody = await endpoints.reassign(request("{}"), "target");
    expect(emptyBody.status).toBe(409);
    expect(reassign).not.toHaveBeenCalled();

    const response = await endpoints.reassign(
      request('{"workspaceId":"workspace-1"}'),
      "target",
    );
    expect(response.status).toBe(200);
    expect(reassign).toHaveBeenCalledWith(
      expect.objectContaining({ scope: { workspaceId: "workspace-1" } }),
    );

    const rejected = await endpoints.reassign(
      request('{"workspaceId":"workspace-2"}'),
      "target",
    );
    expect(rejected.status).toBe(409);
    expect(reassign).toHaveBeenCalledTimes(1);
  });

  test("prevalidates provider state before asking the store to commit it", async () => {
    const preparedProviderState = {
      expectedSessions: [
        {
          credentialId: "source",
          id: "session-1",
          model: "vendor/model",
          openRouterProviderTag: "together",
        },
      ],
      metadataUpdates: [testSessionCredentialMetadataUpdate()],
    };
    const snapshot = vi.fn(() => ({
      sessions: preparedProviderState.expectedSessions,
    }));
    const prepareProviderState = vi.fn(() =>
      Promise.resolve({ preparedProviderState } as const),
    );

    const { endpoints, reassign } = trackedOpenRouterReassignmentEndpoint(
      snapshot,
      prepareProviderState,
    );

    const response = await reassignTarget(endpoints);
    expect(response.status).toBe(200);
    expect(reassign).toHaveBeenCalledOnce();
    expect(snapshot).toHaveBeenCalledWith({
      credentialId: "target",
      provider: "openrouter",
      scope: undefined,
      userId: TEST_USER_ID,
    });
    expect(prepareProviderState).toHaveBeenCalledWith({
      credentialId: "target",
      provider: "openrouter",
      scope: undefined,
      snapshot: { sessions: preparedProviderState.expectedSessions },
      userId: TEST_USER_ID,
    });
    expect(reassign).toHaveBeenCalledWith(
      expect.objectContaining({ preparedProviderState }),
    );
  });

  test("maps asynchronous provider validation failures without reassigning", async () => {
    await expectValidationFailure(
      () => Promise.reject(new Error("offline")),
      502,
      "openrouter_provider_validation_failed",
    );
  });

  test("does not reassign when asynchronous provider validation fails", async () => {
    await expectValidationFailure(
      () => Promise.resolve({ error: "provider_unavailable" } as const),
      409,
      "openrouter_provider_unavailable",
    );
  });
});
