import type { AgentImage } from "../shared/agent-images.ts";
import { sessionQuestionAnswerPath, SESSIONS_PATH } from "../shared/routes.ts";
import { requestJson } from "./browser-http.ts";

export function answerSessionQuestionsRequest(
  sessionId: string,
  requestId: string,
  answers: unknown,
): Promise<unknown> {
  return requestJson(sessionQuestionAnswerPath(sessionId, requestId), {
    body: JSON.stringify(answers),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
}

export function sendSessionMessageRequest(
  sessionId: string,
  prompt: string,
  images: readonly AgentImage[],
): Promise<unknown> {
  return requestJson(
    `${SESSIONS_PATH}/${encodeURIComponent(sessionId)}/messages`,
    {
      body: JSON.stringify({
        ...(images.length === 0 ? {} : { images }),
        prompt,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
  );
}
