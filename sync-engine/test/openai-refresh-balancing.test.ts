import { Buffer } from "node:buffer";
import { describe, expect, test } from "vitest";
import { createCredentialCipher } from "../../shared/credential-cipher.ts";
import { balancedCredentialId } from "../../shared/provider-credential-pool.ts";
import { ProviderCredentialStore } from "../../shared/provider-credential-store.ts";
import { ModelCredentialPool } from "../model-credential-pool.ts";
import { createOpenAiIntegrationFromEnvironment } from "../openai.ts";
import {
  createAuthenticatedTestContext,
  TEST_NOW,
  TEST_USER_ID,
  TEST_WORKSPACE_ID,
} from "./authenticated-integration-test-helpers.ts";

const FIRST_CREDENTIAL_ID = "018bcfe5-6800-7000-8000-000000000091";
const SECOND_CREDENTIAL_ID = "018bcfe5-6800-7000-8000-000000000092";
const CREDENTIAL_KEY = Buffer.alloc(32, 12).toString("base64url");
const SELECTION = {
  workspaceId: TEST_WORKSPACE_ID,
  provider: "openai" as const,
  credentialId: balancedCredentialId("openai"),
};

function expiredCredential(refresh: string): string {
  return JSON.stringify({
    access: `expired-${refresh}`,
    expires: TEST_NOW,
    refresh,
  });
}

function refreshResponse(refresh: string): Response {
  return Response.json({
    access_token: `access-${refresh}`,
    expires_in: 3_600,
    refresh_token: refresh,
  });
}

function refreshToken(request: Request, refreshes: string[]): Promise<string> {
  return request.text().then((body) => {
    const refresh = new URLSearchParams(body).get("refresh_token");
    if (refresh === null) throw new Error("Missing refresh token");
    refreshes.push(refresh);
    return refresh;
  });
}

function trackedRefreshFetch(
  refreshes: string[],
  respond: (refresh: string) => Promise<Response> | Response,
): (request: Request) => Promise<Response> {
  return async (request) => respond(await refreshToken(request, refreshes));
}

async function candidateIds(
  setup: ReturnType<typeof refreshPool>,
): Promise<readonly string[]> {
  const candidates = await setup.pool.candidates(TEST_USER_ID, SELECTION);
  return candidates.map(({ id }) => id);
}

function refreshPool(
  fetch: (request: Request) => Promise<Response>,
  credentialIds = [FIRST_CREDENTIAL_ID, SECOND_CREDENTIAL_ID],
) {
  const { auth, database } = createAuthenticatedTestContext();
  const ids = [...credentialIds];
  const store = new ProviderCredentialStore(
    database,
    createCredentialCipher(CREDENTIAL_KEY),
    "openai",
    () => {
      const id = ids.shift();
      if (id === undefined) throw new Error("The test ran out of IDs");
      return id;
    },
  );
  for (const [index, id] of credentialIds.entries()) {
    const refresh = `refresh-${String(index + 1)}`;
    const added = store.add(
      TEST_USER_ID,
      expiredCredential(refresh),
      { accountId: `account-${id}`, label: `Account ${String(index + 1)}` },
      "oauth",
      TEST_NOW,
    );
    expect(added.id).toBe(id);
  }
  const integration = createOpenAiIntegrationFromEnvironment(
    {
      OPENAI_CLIENT_ID: "test-client",
      OPENAI_CREDENTIAL_KEY: CREDENTIAL_KEY,
    },
    auth,
    {
      database,
      fetch: (input, init) => fetch(new Request(input, init)),
      now: () => TEST_NOW,
    },
  );
  const pool = new ModelCredentialPool({
    database,
    readCredential: (userId, selection) =>
      integration.readCredential(
        userId,
        selection.credentialId,
        selection.workspaceId,
      ),
  });
  return { database, pool };
}

describe("OpenAI OAuth refresh balancing", () => {
  test.each([
    [401, { error: "unauthorized" }],
    [400, { error: "invalid_grant" }],
    [400, { error: "invalid_client" }],
  ])(
    "cools down a definitively rejected refresh (%i) and falls through",
    async (status, body) => {
      const refreshes = new Array<string>();
      const setup = refreshPool(
        trackedRefreshFetch(refreshes, (refresh) =>
          refresh === "refresh-1"
            ? Response.json(body, { status })
            : refreshResponse(refresh),
        ),
      );

      const firstSelection = await candidateIds(setup);
      const secondSelection = await candidateIds(setup);
      expect([firstSelection, secondSelection]).toEqual([
        [SECOND_CREDENTIAL_ID],
        [SECOND_CREDENTIAL_ID],
      ]);
      expect(refreshes).toEqual(["refresh-1", "refresh-2"]);
      setup.database.$client.close();
    },
  );

  test("does not cool down a network refresh failure", async () => {
    let online = false;
    const attempts: string[] = [];
    const setup = refreshPool(
      trackedRefreshFetch(attempts, (refresh) => {
        if (!online) throw new TypeError("refresh endpoint offline");
        return refreshResponse(refresh);
      }),
      [FIRST_CREDENTIAL_ID],
    );

    await expect(candidateIds(setup)).resolves.toEqual([]);
    online = true;
    await expect(candidateIds(setup)).resolves.toEqual([FIRST_CREDENTIAL_ID]);
    expect(attempts).toEqual(["refresh-1", "refresh-1"]);
    setup.database.$client.close();
  });
});
