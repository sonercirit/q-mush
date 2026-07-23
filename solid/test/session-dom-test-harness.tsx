import { type JSX } from "solid-js";
import { render } from "solid-js/web";
import type {
  AgentSessionDetail,
  AgentSessionMessage,
} from "../../shared/session-model.ts";
import { SessionController } from "../session-controller.ts";
import { SessionDetail } from "../session-detail-client.tsx";
import { sessionDetailState } from "./session-detail-test-state.ts";

export class DomTestHarness {
  readonly disposals: (() => void)[] = [];

  dispose(): void {
    while (this.disposals.length > 0) {
      this.disposals.pop()?.();
    }
    document.body.replaceChildren();
  }

  mount(renderView: () => JSX.Element): HTMLDivElement {
    const container = document.createElement("div");
    document.body.append(container);
    this.disposals.push(render(renderView, container));
    return container;
  }

  query(container: ParentNode, selector: string): Element {
    const element = container.querySelector(selector);
    if (element === null) {
      throw new Error(`The test element ${selector} was not rendered`);
    }
    return element;
  }

  mountSession(detail: AgentSessionDetail): {
    readonly container: HTMLDivElement;
    readonly controller: SessionController;
  } {
    const reactive = sessionDetailState(detail);
    const controller = new SessionController(reactive);
    return {
      container: this.mount(() => (
        <SessionDetail controller={controller} state={reactive.state()} />
      )),
      controller,
    };
  }

  messageBoundary(container: ParentNode, id: string): Element {
    return this.query(container, `[data-render-boundary='message:${id}']`);
  }
}

export function transcriptTestMessage(
  id: string,
  content: string,
  role: AgentSessionMessage["role"],
  createdAt: number,
): AgentSessionMessage {
  const metadata = {
    images: Array<AgentSessionMessage["images"][number]>(),
    toolCallId: null,
    toolCalls: Array<AgentSessionMessage["toolCalls"][number]>(),
    toolName: null,
  };
  const message: AgentSessionMessage = {
    content,
    createdAt,
    id,
    role,
    ...metadata,
  };
  return message;
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
