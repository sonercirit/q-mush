import { isRecord } from "../../shared/auth-model.ts";
import type { connectedSessionSetup } from "./session-integration-fixtures.ts";

export function closeToolSession(
  setup: ReturnType<typeof connectedSessionSetup>,
): void {
  if (setup.runnerCommands.length > 0) {
    throw new Error("Unexpected queued runner command");
  }
  setup.database.$client.close();
}

export function isToolResult(
  message: unknown,
  name: string,
): message is Readonly<Record<string, unknown>> & { readonly content: string } {
  return (
    isRecord(message) &&
    message["role"] === "tool" &&
    message["toolName"] === name &&
    typeof message["content"] === "string"
  );
}

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
    if (isToolResult(message, name)) {
      contents.push(message.content);
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
