import { SESSIONS_PATH } from "../shared/routes.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";
import { requestJson } from "./browser-http.ts";
import type { SessionViewState } from "./session-client.tsx";
import { readSessionDetail } from "./session-codec.ts";
import type { SessionMutation } from "./session-mutations.ts";

export function createSessionFromDraft(
  draft: SessionViewState["draft"],
  credential: { readonly credentialId: string; readonly provider: string },
): Promise<AgentSessionDetail> {
  return requestJson(SESSIONS_PATH, {
    body: JSON.stringify({
      ...(draft.images.length === 0 ? {} : { images: draft.images }),
      ...credential,
      ...(draft.model.trim().length === 0 ? {} : { model: draft.model.trim() }),
      prompt: draft.prompt.trim(),
      ...(draft.reasoningEffort.length === 0
        ? {}
        : { reasoningEffort: draft.reasoningEffort }),
      runnerId: draft.runnerId,
      tools: draft.tools,
      workingDirectory: draft.workingDirectory.trim(),
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  }).then(readSessionDetail);
}

export function sendSessionMessage(
  sessionId: string,
  prompt: string,
  images: SessionViewState["followUpImages"],
): SessionMutation {
  // cpd-ignore-start -- The message mutation deliberately mirrors the JSON POST transport.
  return {
    action: "send that instruction",
    pending: "sending",
    request: () =>
      requestJson(
        `${SESSIONS_PATH}/${encodeURIComponent(sessionId)}/messages`,
        {
          body: JSON.stringify({
            ...(images.length === 0 ? {} : { images }),
            prompt,
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      ),
  };
  // cpd-ignore-end
}
