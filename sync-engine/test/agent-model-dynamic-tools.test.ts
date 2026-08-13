import { expect, test } from "vitest";
import { isRecord } from "../../shared/auth-model.ts";
import { ChatCompletionsAgentModel } from "../agent-model.ts";
import { codexOAuthCredential } from "./prompt-cache-fixtures.ts";
import {
  COMPLETED_EVENT,
  FakeProviderSockets,
} from "./provider-recovery-fixtures.ts";

test("OpenAI dynamic allowed_tools keeps the full cached catalog stable", async () => {
  const sockets = new FakeProviderSockets();
  const model = new ChatCompletionsAgentModel({
    credential: codexOAuthCredential(),
    dynamicToolCache: true,
    fetch: () => Promise.reject(new Error("HTTP fallback should not run")),
    maxOutputTokens: null,
    model: "gpt-5-codex",
    provider: "openai",
    tools: ["read", "parallel"],
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
        { name: "parallel", type: "function" },
      ],
      type: "allowed_tools",
    },
  });
  const tools = isRecord(body) ? body["tools"] : undefined;
  expect(Array.isArray(tools) ? tools.length : 0).toBeGreaterThan(2);
  socket.receive(COMPLETED_EVENT);
  await expect(pending).resolves.toMatchObject({ content: "Done." });
});
