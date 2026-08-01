import { createMemo, type Accessor } from "solid-js";
import type {
  AgentSessionMessage,
  AgentSessionStatus,
  AgentSessionTurn,
} from "../shared/session-model.ts";
import { sessionStepTiming } from "../shared/session-step-timing.ts";

type SessionStepTiming = ReturnType<typeof sessionStepTiming>;

function isStreamedMessage(message: AgentSessionMessage | undefined): boolean {
  return message?.id.startsWith("stream:") ?? false;
}

function streamedSuffixTimingUnchanged(
  previous: readonly AgentSessionMessage[],
  current: readonly AgentSessionMessage[],
): boolean {
  if (previous.length !== current.length) return false;

  let streamStart = current.length;
  while (streamStart > 0 && isStreamedMessage(current[streamStart - 1])) {
    streamStart -= 1;
  }
  if (streamStart === current.length) return false;
  if (
    streamStart > 0 &&
    previous[streamStart - 1] !== current[streamStart - 1]
  ) {
    return false;
  }

  for (let index = streamStart; index < current.length; index += 1) {
    const priorMessage = previous[index];
    const currentMessage = current[index];
    if (
      currentMessage === undefined ||
      priorMessage?.id !== currentMessage.id ||
      priorMessage.role !== currentMessage.role ||
      priorMessage.createdAt !== currentMessage.createdAt ||
      priorMessage.turnId !== currentMessage.turnId
    ) {
      return false;
    }
  }
  return true;
}

export function createSessionStepTiming(
  messages: Accessor<readonly AgentSessionMessage[]>,
  status: Accessor<AgentSessionStatus>,
  turns: Accessor<readonly AgentSessionTurn[] | undefined>,
): Accessor<SessionStepTiming> {
  let previousMessages: readonly AgentSessionMessage[] | undefined;
  let previousStatus: AgentSessionStatus | undefined;
  let previousTurns: readonly AgentSessionTurn[] | undefined;

  return createMemo((previous: SessionStepTiming | undefined) => {
    const currentMessages = messages();
    const currentStatus = status();
    const currentTurns = turns();
    const reusable =
      previous !== undefined &&
      previousMessages !== undefined &&
      previousStatus === currentStatus &&
      previousTurns === currentTurns &&
      streamedSuffixTimingUnchanged(previousMessages, currentMessages);

    previousMessages = currentMessages;
    previousStatus = currentStatus;
    previousTurns = currentTurns;
    return reusable
      ? previous
      : sessionStepTiming(currentMessages, currentStatus, currentTurns);
  });
}
