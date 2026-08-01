import { afterEach, expect, test } from "vitest";
import type {
  AgentSessionDetail,
  AgentSessionMessage,
} from "../../shared/session-model.ts";
import { disposeTestViews, queryTestElementAs } from "./dom-test-helpers.ts";
import { defineElementWidth } from "./element-size-test-helpers.ts";
import {
  applyTranscriptDelta,
  mountTestTranscript,
  type MountedTestTranscript,
} from "./session-dom-test-helpers.tsx";
import { transcriptMessage } from "./transcript-ordering-fixtures.ts";

const disposals: (() => void)[] = [];
const LONG_LINE = "long-tool-output-".repeat(40);

function toolResultMessage(content: string): AgentSessionMessage {
  return {
    ...transcriptMessage("tool-result-wrap", content, "assistant", 3),
    role: "tool",
    toolCallId: "call-wrap",
    toolName: "bash",
  };
}

function shellOutput(content: string): string {
  return `stdout:\n${content}\nExit code: 0`;
}

function mountedToolResult(): MountedTestTranscript {
  return mountTestTranscript(
    [toolResultMessage(shellOutput(LONG_LINE))],
    disposals,
  );
}

function outputPane(container: ParentNode): HTMLElement {
  return queryTestElementAs(
    container,
    "[aria-label='Standard output'] pre",
    HTMLElement,
  );
}

function paneWrapToggle(pane: HTMLElement): HTMLButtonElement {
  const container = pane.parentElement;
  if (container === null) {
    throw new TypeError("Missing subscroll pane container");
  }
  return queryTestElementAs(
    container,
    "[data-subscroll-wrap-toggle='true']",
    HTMLButtonElement,
  );
}

function wrapToggle(container: ParentNode): HTMLButtonElement {
  return paneWrapToggle(outputPane(container));
}

function expectWrapState(
  pane: HTMLElement,
  toggle: HTMLButtonElement,
  wrapped: boolean,
): void {
  expect(pane.dataset["lineWrap"]).toBe(String(wrapped));
  expect(toggle.getAttribute("aria-pressed")).toBe(String(wrapped));
  expect(toggle.textContent).toContain(wrapped ? "On" : "Off");
}

function setUnwrappedScroll(
  pane: HTMLElement,
  toggle: HTMLButtonElement,
): void {
  defineElementWidth(pane, 100, 400);
  toggle.click();
  pane.scrollLeft = 73;
  pane.dispatchEvent(new Event("scroll"));
}

async function expectRestoredPane(
  initialPane: HTMLElement,
  updatedPane: HTMLElement,
): Promise<void> {
  defineElementWidth(updatedPane, 100, 500);
  await Promise.resolve();
  expect(updatedPane).not.toBe(initialPane);
  expectWrapState(updatedPane, paneWrapToggle(updatedPane), false);
  expect(updatedPane.scrollLeft).toBe(73);
}

afterEach(() => {
  disposeTestViews(disposals);
});

test("wraps long tool-result lines by default and toggles horizontal scrolling", () => {
  const { container } = mountedToolResult();
  const pane = outputPane(container);
  const toggle = wrapToggle(container);

  expectWrapState(pane, toggle, true);
  expect(pane.className).toContain("data-[line-wrap=true]:overflow-x-hidden");
  expect(pane.className).toContain("data-[line-wrap=false]:overflow-x-auto");

  toggle.click();

  expectWrapState(pane, toggle, false);
});

test("keeps a tool-result pane unwrapped across transcript updates", async () => {
  const { container, controller, detail } = mountedToolResult();
  const initialPane = outputPane(container);
  setUnwrappedScroll(initialPane, wrapToggle(container));

  const updatedMessage = toolResultMessage(
    shellOutput(`${LONG_LINE} streamed-update`),
  );
  const updatedDetail: AgentSessionDetail = {
    ...detail,
    messages: [updatedMessage],
    updatedAt: detail.updatedAt + 1,
  };
  controller.applyDetail(updatedDetail);
  await expectRestoredPane(initialPane, outputPane(container));
});

test("keeps a code pane unwrapped while its message streams", async () => {
  const { container, controller, detail } = mountTestTranscript(
    [transcriptMessage("user-code-wrap", "Show code", "user", 2)],
    disposals,
  );
  applyTranscriptDelta(
    controller,
    detail.id,
    `\`\`\`ts\nconst value = "${LONG_LINE}";`,
  );
  const initialPane = queryTestElementAs(
    container,
    "pre[data-language='ts']",
    HTMLElement,
  );
  setUnwrappedScroll(initialPane, paneWrapToggle(initialPane));

  applyTranscriptDelta(controller, detail.id, `\nconst next = "${LONG_LINE}";`);
  const updatedPane = queryTestElementAs(
    container,
    "pre[data-language='ts']",
    HTMLElement,
  );
  await expectRestoredPane(initialPane, updatedPane);
});
