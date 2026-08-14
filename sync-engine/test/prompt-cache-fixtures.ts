import { testOpenAiOAuthCredential } from "./agent-model-credential-fixtures.ts";

export const TEST_PROMPT_CACHE_CONTROL = {
  ttl: "1h",
  type: "ephemeral",
} as const;

export function cachedText(text: string): readonly unknown[] {
  return [{ cache_control: TEST_PROMPT_CACHE_CONTROL, text, type: "text" }];
}

export function cachedTextMessage(
  role: "system" | "tool" | "user",
  text: string,
): Readonly<Record<string, unknown>> {
  return { content: cachedText(text), role };
}

export function codexOAuthCredential(): ReturnType<
  typeof testOpenAiOAuthCredential
> {
  return testOpenAiOAuthCredential();
}

export function chatCompletionsDone(): unknown {
  return { choices: [{ message: { content: "Done." } }] };
}
