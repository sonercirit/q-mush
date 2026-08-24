import { afterEach, expect, test } from "vitest";
import { createPromptController, type PromptController } from "../../solid/prompt-controller.ts";
import { createPromptViewState } from "../../solid/prompt-state.ts";
import { createReactiveState } from "../../solid/reactive-state.ts";
import { installFetch } from "./controller-test-helpers.ts";
import { TEST_PROMPT } from "./prompt-fixtures.ts";

const SECOND = {
  ...TEST_PROMPT,
  body: "Write focused tests.",
  createdAt: TEST_PROMPT.createdAt + 2,
  id: "prompt-2",
  name: "Tests",
  updatedAt: TEST_PROMPT.updatedAt + 2,
};
const CHANGED_ERROR =
  "That prompt changed in another window. Your draft was not saved.";
let originalFetch: typeof globalThis.fetch | undefined;

afterEach(() => {
  if (originalFetch !== undefined) {
    globalThis.fetch = originalFetch;
    originalFetch = undefined;
  }
});

function install(
  implementation: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>,
): void {
  originalFetch = installFetch(implementation);
}

function collection(prompts: readonly (typeof TEST_PROMPT)[]): Response {
  return Response.json({ prompts });
}

async function loadedController(): Promise<PromptController> {
  const controller = createPromptController();
  await controller.load();
  return controller;
}

function staleResponse(method: "DELETE" | "PUT", changed: typeof TEST_PROMPT) {
  let reads = 0;
  install((_input, init = {}) => {
    if (init.method === method) {
      return Promise.resolve(
        Response.json({ error: "prompt_changed" }, { status: 412 }),
      );
    }
    reads += 1;
    return Promise.resolve(collection([reads === 1 ? TEST_PROMPT : changed]));
  });
}

test("loads, creates, edits, deletes, and sends revisions", async () => {
  const revisions: (string | null)[] = [];
  install((_input, init = {}) => {
    if (init.method === "PUT" || init.method === "DELETE") {
      revisions.push(new Headers(init.headers).get("if-match"));
    }
    const responses = {
      DELETE: (): Promise<Response> =>
        Promise.resolve(new Response(null, { status: 204 })),
      POST: (): Promise<Response> =>
        Promise.resolve(Response.json(SECOND, { status: 201 })),
      PUT: (): Promise<Response> =>
        Promise.resolve(
          Response.json({
            ...TEST_PROMPT,
            body: "Updated body",
            revision: 2,
          }),
        ),
    } satisfies Record<string, () => Promise<Response>>;
    const method = init.method;
    const isMutationMethod = (
      value: string | undefined,
    ): value is keyof typeof responses =>
      value !== undefined && value in responses;
    return (
      (isMutationMethod(method) ? responses[method]() : undefined) ??
      Promise.resolve(collection([TEST_PROMPT]))
    );
  });
  const controller = await loadedController();
  controller.setCreateField("name", SECOND.name);
  controller.setCreateField("body", SECOND.body);
  await controller.create();
  expect(controller.state.prompts).toEqual([TEST_PROMPT, SECOND]);

  controller.beginEdit(TEST_PROMPT.id);
  controller.setEditField("body", "Updated body");
  await controller.saveEdit();
  expect(controller.state.prompts?.[0]?.revision).toBe(2);

  controller.select(SECOND.id);
  await controller.remove(SECOND.id);
  expect(controller.state.selectedId).toBeUndefined();
  expect(revisions).toEqual(['"1"', '"1"']);
});

test("distinguishes duplicate-name and active-limit errors", async () => {
  let error = "duplicate_name";
  install((_input, init = {}) =>
    Promise.resolve(
      init.method === "POST"
        ? Response.json({ error }, { status: 409 })
        : collection([TEST_PROMPT]),
    ),
  );
  const controller = await loadedController();
  controller.setCreateField("name", "Duplicate");
  controller.setCreateField("body", "Draft body");
  await controller.create();
  expect(controller.state.error).toBe(
    "A prompt with that name already exists.",
  );

  error = "prompt_limit_reached";
  await controller.create();
  expect(controller.state).toMatchObject({
    createDraft: { body: "Draft body", name: "Duplicate" },
    error:
      "You have reached the limit of 100 saved prompts. Delete one before saving another.",
  });
});

test("refreshes stale edits without discarding their draft", async () => {
  const changed = { ...TEST_PROMPT, body: "Changed elsewhere", revision: 2 };

  staleResponse("PUT", changed);
  const controller = await loadedController();
  controller.beginEdit(TEST_PROMPT.id);
  controller.setEditField("body", "My stale change");
  await controller.saveEdit();

  expect(controller.state).toMatchObject({
    editDraft: { body: "My stale change" },
    error: CHANGED_ERROR,
    prompts: [changed],
    saving: false,
  });
});

test("refreshes stale deletes and keeps the prompt", async () => {
  const changed = { ...TEST_PROMPT, revision: 2 };
  staleResponse("DELETE", changed);
  const controller = await loadedController();
  await controller.remove(TEST_PROMPT.id);
  expect(controller.state).toMatchObject({
    error: CHANGED_ERROR,
    prompts: [changed],
    removingId: undefined,
  });
});

test("inserts a copy rather than a link to later edits", () => {
  const controller = createPromptController(
    createReactiveState(createPromptViewState([TEST_PROMPT])),
  );
  controller.select(TEST_PROMPT.id);
  const inserted: string[] = [];
  controller.insertSelected((body) => {
    inserted.push(body);
    return true;
  });
  controller.beginEdit(TEST_PROMPT.id);
  controller.setEditField("body", "Changed after insertion");
  expect(inserted).toEqual([TEST_PROMPT.body]);
});
