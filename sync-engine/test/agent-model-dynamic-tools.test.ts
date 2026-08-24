import { expect, test } from "vitest";
import { isRecord } from "../../shared/auth-model.ts";
import { createChatCompletionsAgentModel } from "../agent-model.ts";
import { TEST_CREDENTIAL_FINGERPRINT } from "./agent-model-credential-fixtures.ts";
import { codexOAuthCredential } from "./prompt-cache-fixtures.ts";
import {
  acknowledgeProviderSocket,
  COMPLETED_EVENT,
  createFakeProviderSockets,
} from "./provider-recovery-fixtures.ts";

test("OpenAI dynamic allowed_tools keeps the full cached catalog stable", async () => {
  const sockets = createFakeProviderSockets();
  const model = createChatCompletionsAgentModel({
    credential: codexOAuthCredential(),
    credentialFingerprint: TEST_CREDENTIAL_FINGERPRINT,
    dynamicToolCache: true,
    fetch: () => Promise.reject(new Error("HTTP fallback should not run")),
    maxOutputTokens: null,
    model: "gpt-5-codex",
    provider: "openai",
    toolSettings: {
      executionLimitMinutes: 7,
      outputLimitCharacters: 1_234,
    },
    tools: ["read", "bash", "parallel"],
    webSocket: sockets.create,
  });

  const pending = model.complete([{ content: "hello", role: "user" }]);
  await Promise.resolve();
  const socket = sockets.created[0];
  if (socket === undefined) {
    throw new Error("socket missing");
  }
  socket.open();
  await Promise.resolve();
  expect(socket.sent).toHaveLength(1);
  const body: unknown = JSON.parse(socket.sent[0] ?? "null");
  expect(body).toMatchObject({
    tool_choice: {
      mode: "auto",
      tools: [
        { name: "read", type: "function" },
        { name: "bash", type: "function" },
        { name: "parallel", type: "function" },
      ],
      type: "allowed_tools",
    },
  });
  const tools = isRecord(body) ? body["tools"] : undefined;
  if (!Array.isArray(tools)) {
    throw new TypeError("tools missing");
  }
  expect(tools.length).toBeGreaterThan(3);
  const bash: unknown = tools.find(
    (tool: unknown) => isRecord(tool) && tool["name"] === "bash",
  );
  expect(bash).toMatchObject({
    parameters: { properties: { timeout: { maximum: 420 } } },
  });
  acknowledgeProviderSocket(socket);
  socket.receive(COMPLETED_EVENT);
  await expect(pending).resolves.toMatchObject({ content: "Done." });
});
