import type { ChatCompletionsAgentModel } from "../../sync-engine/agent-model.ts";
import {
  TEST_CREDENTIAL_FINGERPRINT,
  testOpenAiOAuthCredential,
} from "./agent-model-credential-fixtures.ts";

export const DONE_CODEX_OUTPUT = {
  content: [{ text: "Done.", type: "output_text" }],
  type: "message",
};

type ModelOptions = ConstructorParameters<typeof ChatCompletionsAgentModel>[0];

export function codexModelOptions(
  options: Omit<
    ModelOptions,
    "credential" | "credentialFingerprint" | "maxOutputTokens" | "provider"
  >,
): ModelOptions {
  return {
    ...options,
    credential: testOpenAiOAuthCredential(),
    credentialFingerprint: TEST_CREDENTIAL_FINGERPRINT,
    maxOutputTokens: null,
    provider: "openai",
  };
}

export function completeHello(
  model: ChatCompletionsAgentModel,
): ReturnType<ChatCompletionsAgentModel["complete"]> {
  return model.complete([{ content: "Hello", role: "user" }]);
}

export function codexEventResponse(
  output: readonly unknown[],
  prefix = "",
  usage?: Readonly<Record<string, number>>,
): Response {
  const completed = {
    response: { output, ...(usage === undefined ? {} : { usage }) },
    type: "response.completed",
  };
  return new Response(
    `${prefix}data: ${JSON.stringify(completed)}\n\ndata: [DONE]\n\n`,
  );
}
