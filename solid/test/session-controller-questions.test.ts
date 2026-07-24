import { createRoot } from "solid-js";
import { expect, test } from "vitest";
import {
  sessionQuestionAnswerPath,
  SESSIONS_PATH,
} from "../../shared/routes.ts";
import type { AgentSessionDetail } from "../../shared/session-model.ts";
import { summaryFromDetail } from "../session-codec.ts";
import { SessionController } from "../session-controller.ts";
import { requestUrl } from "./controller-test-helpers.ts";
import { TEST_SESSION_DETAIL } from "./session-fixtures.ts";

function waitingSessionDetail(): AgentSessionDetail {
  /* jscpd:ignore-start */
  return {
    ...TEST_SESSION_DETAIL,
    pendingQuestions: {
      createdAt: 3,
      id: "request/1",
      questions: [
        {
          id: "direction",
          options: [
            { label: "Proceed", value: "proceed" },
            { label: "Stop", value: "stop" },
          ],
          prompt: "What next?",
          type: "single_choice",
        },
      ],
      toolCallId: "call-1",
    },
    status: "waiting",
  };
  /* jscpd:ignore-end */
}

test("ignores stale pending question notifications", async () => {
  /* jscpd:ignore-start */
  const waiting = waitingSessionDetail();
  const resumed: AgentSessionDetail = {
    ...waiting,
    pendingQuestions: null,
    status: "running",
    updatedAt: 4,
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    (input: RequestInfo | URL) => {
      const path = new URL(requestUrl(input), "http://localhost").pathname;
      return Promise.resolve(
        path === SESSIONS_PATH
          ? Response.json({ sessions: [summaryFromDetail(resumed)] })
          : Response.json(resumed),
      );
    },
    { preconnect: originalFetch.preconnect },
  );

  try {
    const controller = createRoot(() => new SessionController());
    await controller.load();
    controller.applyQuestions({
      pending: waiting.pendingQuestions,
      sessionId: waiting.id,
      type: "session_questions",
    });
    expect(controller.state.detail?.pendingQuestions).toBeNull();

    controller.applyDetail(waiting);
    controller.applyQuestions({
      pending: null,
      sessionId: waiting.id,
      type: "session_questions",
    });
    expect(controller.state.detail?.pendingQuestions).toEqual(
      waiting.pendingQuestions,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  /* jscpd:ignore-end */
});

test("posts pending answers while ignoring realtime replacement events", async () => {
  /* jscpd:ignore-start */
  const waiting = waitingSessionDetail();
  const resumed: AgentSessionDetail = {
    ...waiting,
    pendingQuestions: null,
    status: "queued",
    updatedAt: 4,
  };
  const requests: Request[] = [];
  let releaseAnswer: (() => void) | undefined;
  const answerReady = new Promise<void>((resolve) => {
    releaseAnswer = resolve;
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(
        new URL(requestUrl(input), "http://localhost"),
        init,
      );
      requests.push(request);
      const path = new URL(request.url).pathname;
      if (path === SESSIONS_PATH) {
        return Promise.resolve(
          Response.json({ sessions: [summaryFromDetail(waiting)] }),
        );
      }
      if (path === `/api/sessions/${waiting.id}`) {
        return Promise.resolve(Response.json(waiting));
      }
      return answerReady.then(() => Response.json(resumed));
    },
    { preconnect: originalFetch.preconnect },
  );

  try {
    const controller = createRoot(() => new SessionController());
    await controller.load();
    const answers = {
      answers: [{ questionId: "direction", value: "proceed" }],
    } as const;
    const submission = controller.answerQuestions(answers);

    expect(controller.state.answeringQuestions).toBe(true);
    controller.applyQuestions({
      pending: null,
      sessionId: waiting.id,
      type: "session_questions",
    });
    controller.applyDetail(resumed);
    controller.applyRealtime([summaryFromDetail(resumed)]);
    expect(controller.state.detail?.pendingQuestions).toEqual(
      waiting.pendingQuestions,
    );
    const answerRequest = requests.at(-1);
    expect(answerRequest?.url).toBe(
      `http://localhost${sessionQuestionAnswerPath(waiting.id, "request/1")}`,
    );
    expect(answerRequest?.method).toBe("POST");
    expect(answerRequest?.headers.get("content-type")).toBe("application/json");
    expect(await answerRequest?.json()).toEqual(answers);

    releaseAnswer?.();
    await submission;
    expect(controller.state.answeringQuestions).toBe(false);
    expect(controller.state.detail).toEqual(resumed);
  } finally {
    globalThis.fetch = originalFetch;
  }
  /* jscpd:ignore-end */
});
