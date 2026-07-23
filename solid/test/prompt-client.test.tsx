import { expect, test } from "vitest";
import { PromptBank } from "../../solid/prompt-client.tsx";
import { PromptController } from "../../solid/prompt-controller.ts";
import {
  createPromptViewState,
  type PromptViewState,
} from "../../solid/prompt-state.ts";
import { createReactiveState } from "../../solid/reactive-state.ts";
import { TEST_PROMPT } from "./prompt-fixtures.ts";
import { renderSolidToString } from "./render-solid.tsx";

test("renders prompt creation, selection, editing, and deletion controls", () => {
  const state: PromptViewState = {
    ...createPromptViewState([TEST_PROMPT]),
    editDraft: { body: "Editable body", name: "Editable name" },
    editingId: TEST_PROMPT.id,
    selectedId: TEST_PROMPT.id,
  };
  const controller = new PromptController(createReactiveState(state));
  const html = renderSolidToString(() => (
    <PromptBank
      controller={controller}
      onInsert={() => {
        // Rendering does not insert a prompt.
      }}
    />
  ));

  expect(html).toContain('data-prompt-bank="true"');
  expect(html).toContain("Prompt bank");
  expect(html).toContain('id="prompt-name"');
  expect(html).toContain('id="prompt-body"');
  expect(html).toContain('data-prompt-id="prompt-1"');
  expect(html).toContain('name="editName"');
  expect(html).toContain('name="editBody"');
  expect(html).toContain(">Save changes</button>");
  expect(html).toContain(">Delete</button>");
  expect(html).toContain(">Insert into task</button>");
  expect(html).toContain("Editable body");
});

test("renders loading, empty, and duplicate-name error states", () => {
  const loadingController = new PromptController(
    createReactiveState(createPromptViewState(undefined)),
  );
  const emptyState: PromptViewState = {
    ...createPromptViewState([]),
    error: "A prompt with that name already exists.",
  };
  const emptyController = new PromptController(createReactiveState(emptyState));
  const ignoreInsert = (): void => {
    // The server-rendered test does not activate controls.
  };
  const loadingHtml = renderSolidToString(() => (
    <PromptBank controller={loadingController} onInsert={ignoreInsert} />
  ));
  const emptyHtml = renderSolidToString(() => (
    <PromptBank controller={emptyController} onInsert={ignoreInsert} />
  ));

  expect(loadingHtml).toContain("Loading prompts…");
  expect(emptyHtml).toContain("No saved prompts yet");
  expect(emptyHtml).toContain("already exists");
});
