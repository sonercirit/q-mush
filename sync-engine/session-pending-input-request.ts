import { readAgentImages } from "../shared/agent-images.ts";
import { isRecord } from "../shared/auth-model.ts";
import type { SessionPendingInputRequest } from "../shared/session-pending-input.ts";
import { readIdentifier } from "./session-request-helpers.ts";

const MAXIMUM_PROMPT_LENGTH = 32_768;

export interface SessionPendingInputCommand extends SessionPendingInputRequest {
  readonly prompt: string;
  readonly sessionId: string;
}

export function readSessionPendingInputCommand(
  value: unknown,
): SessionPendingInputCommand | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const clientRequestId = readIdentifier(value["clientRequestId"]);
  const images = readAgentImages(value["images"]);
  const kind = value["kind"];
  const prompt = value["prompt"];
  const sessionId = readIdentifier(value["sessionId"]);
  if (
    clientRequestId === undefined ||
    images === undefined ||
    (kind !== "follow_up" && kind !== "steer") ||
    typeof prompt !== "string" ||
    prompt.length > MAXIMUM_PROMPT_LENGTH ||
    sessionId === undefined
  ) {
    return undefined;
  }
  const content = prompt.trim();
  return content.length === 0 && images.length === 0
    ? undefined
    : { clientRequestId, images, kind, prompt: content, sessionId };
}
