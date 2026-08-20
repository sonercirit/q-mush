import type { AgentSessionMessage } from "../../shared/session-model.ts";
import { TEST_SESSION_DETAIL } from "../../shared/test/session-fixtures.ts";
import type { ReadSessionToolInput } from "../session-agent-read.ts";

export function readSessionOutputFixture(options: {
  readonly input: ReadSessionToolInput;
  readonly matchedRecords?: number;
  readonly transcript: readonly AgentSessionMessage[];
}) {
  const { input, matchedRecords, transcript } = options;
  return {
    input,
    ...(matchedRecords === undefined ? {} : { matchedRecords }),
    messages: transcript,
    session: {
      id: TEST_SESSION_DETAIL.id,
      status: "idle",
      title: "Session",
    },
    systemPrompt: "system",
    toolDefinitions: [],
  } as const;
}
