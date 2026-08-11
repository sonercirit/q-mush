import { expect, test, vi } from "vitest";
import { TEST_USER_ID } from "./authenticated-integration-test-helpers.ts";
import { ScriptedAgentModel } from "./scripted-agent-model.ts";
import { startToolSession } from "./session-agent-tool-setup.ts";

test("session creation never reaches the network without injected discovery", async () => {
  const fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("Tests must not fetch"));
  try {
    const setup = await startToolSession(
      new ScriptedAgentModel([
        { content: "No discovery needed.", toolCalls: [] },
      ]),
    );
    const [session] = setup.sessions.listForUser(TEST_USER_ID);
    expect(session?.maxContextTokens ?? null).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    setup.database.$client.close();
  } finally {
    fetchSpy.mockRestore();
  }
});
