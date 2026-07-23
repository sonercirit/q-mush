import { isRecord } from "../../shared/auth-model.ts";

export function findToolResultContent(
  value: unknown,
  name: string,
): string | undefined {
  const messagesValue = isRecord(value) ? value["messages"] : null;
  if (messagesValue === null || !Array.isArray(messagesValue)) {
    return undefined;
  }
  const messages: readonly unknown[] = messagesValue;
  for (const message of messages) {
    if (
      isRecord(message) &&
      message["role"] === "tool" &&
      message["toolName"] === name &&
      typeof message["content"] === "string"
    ) {
      return message["content"];
    }
  }
  return undefined;
}
