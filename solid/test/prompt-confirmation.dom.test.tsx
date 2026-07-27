import type { JSX } from "solid-js";
import { afterEach, expect, test, vi } from "vitest";
import { PromptBank } from "../prompt-client.tsx";
import { PromptController } from "../prompt-controller.ts";
import { createPromptViewState } from "../prompt-state.ts";
import { createReactiveState } from "../reactive-state.ts";
import {
  clickTestButton,
  disposeTestViews,
  mountTestView,
} from "./dom-test-helpers.ts";
import { TEST_PROMPT } from "./prompt-fixtures.ts";

const disposals: (() => void)[] = [];
const SECOND_PROMPT = {
  ...TEST_PROMPT,
  id: "prompt-2",
  name: "Second prompt",
  revision: 2,
};

function mountPromptBank(
  onInsert: (body: string, replace: boolean) => boolean = () => true,
) {
  const reactive = createReactiveState(
    createPromptViewState([TEST_PROMPT, SECOND_PROMPT]),
  );
  const controller = new PromptController(reactive);
  const renderBank = (): JSX.Element => (
    <PromptBank controller={controller} onInsert={onInsert} />
  );
  const container = mountTestView(renderBank, disposals);
  return { container, controller, reactive };
}

afterEach(() => {
  disposeTestViews(disposals);
});

test("asks before replacing a task draft and binds approval to its prompt", () => {
  const insert = vi
    .fn<(body: string, replace: boolean) => boolean>()
    .mockImplementation((_body, replace) => replace);
  const { container } = mountPromptBank(insert);
  clickTestButton(container, `[data-prompt-id='${TEST_PROMPT.id}'] > button`);
  clickTestButton(container, "[data-insert-prompt='true']");
  expect(
    container.querySelector("[role='alertdialog']")?.textContent,
  ).toContain("Replace the current task draft?");
  expect(insert).toHaveBeenLastCalledWith(TEST_PROMPT.body, false);

  clickTestButton(container, `[data-prompt-id='${SECOND_PROMPT.id}'] > button`);
  expect(container.textContent).not.toContain(
    "Replace the current task draft?",
  );
  clickTestButton(container, "[data-insert-prompt='true']");
  clickTestButton(container, "[data-confirm-prompt-insert='true']");
  expect(insert).toHaveBeenLastCalledWith(SECOND_PROMPT.body, true);
});

test("requires confirmation before deleting a prompt", async () => {
  const { container, controller, reactive } = mountPromptBank();
  const remove = vi.spyOn(controller, "remove").mockResolvedValue();
  clickTestButton(
    container,
    `[data-prompt-id='${TEST_PROMPT.id}'] [data-delete-prompt='true']`,
  );
  expect(remove).not.toHaveBeenCalled();
  expect(reactive.state().confirmDeleteId).toBe(TEST_PROMPT.id);

  clickTestButton(container, "[data-confirm-prompt-delete='true']");
  await Promise.resolve();
  expect(remove).toHaveBeenCalledExactlyOnceWith(TEST_PROMPT.id);
});
