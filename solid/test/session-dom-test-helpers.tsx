import type { JSX } from "solid-js";
import type {
  AgentSessionDetail,
  AgentSessionMessage,
} from "../../shared/session-model.ts";
import type { ReactiveState } from "../reactive-state.ts";
import { RenderDebugProvider, type RenderDebugView } from "../render-debug.tsx";
import type { SessionViewState } from "../session-client.tsx";
import { summaryFromDetail } from "../session-codec.ts";
import { SessionController } from "../session-controller.ts";
import { SessionDetailBody } from "../session-detail-body.tsx";
import { SessionDetail } from "../session-detail-client.tsx";
import type { SessionTranscriptFilterStorage } from "../session-transcript-filters.ts";
import type { SessionCommandTransport } from "../session-transport.ts";
import { mountTestView, queryTestElement } from "./dom-test-helpers.ts";
import { sessionDetailState } from "./session-detail-test-state.ts";
import { runningSessionDetail } from "./transcript-ordering-fixtures.ts";

export const DOM_TEST_DISPOSALS: (() => void)[] = [];

export function messageBoundary(container: ParentNode, id: string): Element {
  return queryTestElement(container, `[data-render-boundary='message:${id}']`);
}

export interface MountedTestSession {
  readonly container: HTMLDivElement;
  readonly controller: SessionController;
}

export interface MountedTestTranscript extends MountedTestSession {
  readonly detail: AgentSessionDetail;
}

export function mountSessionDetailBody(
  reactive: ReactiveState<SessionViewState>,
  disposals: (() => void)[],
  transport?: SessionCommandTransport,
  render?: (
    props: Parameters<typeof SessionDetailBody>[0],
    controller: SessionController,
  ) => JSX.Element,
): MountedTestSession {
  const controller = new SessionController(
    reactive,
    undefined,
    null,
    transport,
  );
  const detail = reactive.state().detail;
  if (detail === undefined) throw new TypeError("Missing session detail");
  const bodyProps: Parameters<typeof SessionDetailBody>[0] = {
    contextLabel: "0% context",
    environmentLabel: "Bare Metal",
    modelLabel: "openai · model",
    presentation: <span>Running</span>,
    providerUpdate: {
      credentials: [],
      onApply: () => Promise.resolve(false),
      onDiscoverModels: () =>
        new Promise((resolve) => {
          resolve({ defaultModel: null, models: [] });
        }),
      onDiscoverProviders: () => Promise.resolve({ providers: [] }),
    },
    sessionMetrics: <span>Time: 0s</span>,
    view: {
      controller,
      credentialAvailable: true,
      credentials: [],
      detail,
      onOpenDirectoryPicker: () => undefined,
      runners: [],
      state: reactive.state(),
    },
  };
  const container = mountTestView(
    () =>
      render === undefined ? (
        <SessionDetailBody {...bodyProps} />
      ) : (
        render(bodyProps, controller)
      ),
    disposals,
  );
  return { container, controller };
}

function renderTestSessionDetail(
  controller: SessionController,
  state: ReturnType<typeof sessionDetailState>["state"],
): JSX.Element {
  const detail = () => state().detail;
  return (
    <SessionDetail
      controller={controller}
      credentialAvailable
      credentials={[]}
      onOpenDirectoryPicker={() => {
        controller.openDirectoryPicker();
      }}
      runners={
        detail() === undefined
          ? []
          : [
              {
                architecture: null,
                id: detail()?.runnerId ?? "",
                isDefault: true,
                lastSeenAt: null,
                name: "Test runner",
                platform: null,
                status: "online",
              },
            ]
      }
      state={state()}
    />
  );
}

export function mountTestSessionDetail(
  detail: AgentSessionDetail,
  disposals: (() => void)[] = DOM_TEST_DISPOSALS,
  transcriptFilterStorage: SessionTranscriptFilterStorage | null = null,
): MountedTestSession {
  const reactive = sessionDetailState(detail);
  const controller = new SessionController(
    reactive,
    undefined,
    transcriptFilterStorage,
  );
  const container = mountTestView(
    () => renderTestSessionDetail(controller, reactive.state),
    disposals,
  );
  return { container, controller };
}

export function mountTestTranscript(
  messages: AgentSessionDetail["messages"],
  disposals: (() => void)[],
  debug?: RenderDebugView,
): MountedTestTranscript {
  const detail = runningSessionDetail(messages);
  const reactive = sessionDetailState(detail, [summaryFromDetail(detail)]);
  const controller = new SessionController(reactive, undefined, null);
  const session = (): JSX.Element =>
    renderTestSessionDetail(controller, reactive.state);
  const container = mountTestView(
    () =>
      debug === undefined ? (
        session()
      ) : (
        <RenderDebugProvider staticView={debug}>
          {session()}
        </RenderDebugProvider>
      ),
    disposals,
  );
  return { container, controller, detail };
}

export function createResponseFetch(
  response: unknown,
): typeof globalThis.fetch {
  const originalFetch = globalThis.fetch;
  return Object.assign(
    (): Promise<Response> => Promise.resolve(Response.json(response)),
    { preconnect: originalFetch.preconnect },
  );
}

export function restoreFetchAfterTest(
  originalFetch: typeof globalThis.fetch,
  disposals: (() => void)[] = DOM_TEST_DISPOSALS,
): void {
  disposals.push(() => {
    globalThis.fetch = originalFetch;
  });
}

export function installResponseFetch(
  response: unknown,
  disposals: (() => void)[] = DOM_TEST_DISPOSALS,
): void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createResponseFetch(response);
  restoreFetchAfterTest(originalFetch, disposals);
}

export function transcriptTestMessage(
  id: string,
  content: string,
  role: AgentSessionMessage["role"],
  createdAt: number,
): AgentSessionMessage {
  return {
    content,
    createdAt,
    id,
    images: [],
    role,
    toolCallId: null,
    toolCalls: [],
    toolName: null,
  };
}

export function applyTranscriptDelta(
  controller: SessionController,
  sessionId: string,
  content: string,
  thinking = "",
): void {
  controller.applyDelta({
    content,
    sessionId,
    thinking,
    type: "session_delta",
  });
}
