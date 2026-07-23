import { isRecord } from "../../shared/auth-model.ts";

export function findToolResultContents(
  value: unknown,
  name: string,
): readonly string[] {
  const messagesValue = isRecord(value) ? value["messages"] : null;
  if (!Array.isArray(messagesValue)) {
    return [];
  }
  const contents: string[] = [];
  const messages: readonly unknown[] = messagesValue;
  for (const message of messages) {
    if (
      isRecord(message) &&
      message["role"] === "tool" &&
      message["toolName"] === name &&
      typeof message["content"] === "string"
    ) {
      contents.push(message["content"]);
    }
  }
  return contents;
}

export function findToolResultContent(
  value: unknown,
  name: string,
): string | undefined {
  return findToolResultContents(value, name)[0];
}
