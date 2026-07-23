import { afterEach, expect, test } from "vitest";
import { PROMPTS_PATH, promptPath } from "../../shared/routes.ts";
import { PromptController } from "../../solid/prompt-controller.ts";
import { installTestFetch, requestUrl } from "./controller-test-helpers.ts";
import { TEST_PROMPT } from "./prompt-fixtures.ts";

const FIRST_PROMPT = {
  ...TEST_PROMPT,
  body: "Inspect the repository.",
  createdAt: 1,
  id: "prompt-1",
  name: "Inspect",
  updatedAt: 1,
};
const SECOND_PROMPT = {
  body: "Write focused tests.",
  createdAt: 2,
  id: "prompt-2",
  name: "Tests",
  updatedAt: 2,
};
let restoreFetch: (() => void) | undefined;

afterEach(() => {
  if (restoreFetch !== undefined) {
    restoreFetch();
    restoreFetch = undefined;
  }
});

type PromptResponse = typeof FIRST_PROMPT;

type PromptFetch = (
  input: RequestInfo | URL,
  init: RequestInit,
  prompts: PromptResponse[],
) => { readonly prompts: PromptResponse[]; readonly response: Response };

function promptFetch(
  input: RequestInfo | URL,
  init: RequestInit,
  prompts: PromptResponse[],
): { readonly prompts: PromptResponse[]; readonly response: Response } {
  const url = requestUrl(input);
  const method = init.method ?? "GET";
  if (url === PROMPTS_PATH && method === "GET") {
    return { prompts, response: Response.json({ prompts }) };
  }
  if (url === PROMPTS_PATH && method === "POST") {
    return {
      prompts: [...prompts, SECOND_PROMPT],
      response: Response.json(SECOND_PROMPT, { status: 201 }),
    };
  }
  if (url === promptPath(FIRST_PROMPT.id) && method === "PUT") {
    const updated = { ...FIRST_PROMPT, body: "Updated body", name: "Updated" };
    return {
      prompts: [updated, SECOND_PROMPT],
      response: Response.json(updated),
    };
  }
  if (url === promptPath(SECOND_PROMPT.id) && method === "DELETE") {
    return {
      prompts: prompts.filter(({ id }) => id !== SECOND_PROMPT.id),
      response: new Response(null, { status: 204 }),
    };
  }
  return { prompts, response: new Response(null, { status: 404 }) };
}

function collectionResponse(prompts: readonly PromptResponse[]): Response {
  return Response.json({ prompts });
}

function installFetch(
  implementation: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>,
): void {
  const installed = installTestFetch(implementation);
  restoreFetch = () => {
    installed.restore();
  };
}

test("loads, creates, edits, deletes, and selects prompt drafts", async () => {
  const requests: {
    readonly body: unknown;
    readonly method: string;
    readonly url: string;
  }[] = [];
  let prompts: PromptResponse[] = [FIRST_PROMPT];
  const respond: PromptFetch = promptFetch;
  installFetch((input, init = {}) => {
    const url = requestUrl(input);
    const method = init.method ?? "GET";
    requests.push({
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
      method,
      url,
    });
    const result = respond(input, init, prompts);
    prompts = result.prompts;
    return Promise.resolve(result.response);
  });

  const controller = new PromptController();
  await controller.load();
  expect(controller.state.prompts).toEqual([FIRST_PROMPT]);

  controller.setCreateField("name", " Tests ");
  controller.setCreateField("body", " Write focused tests. ");
  await controller.create();
  expect(controller.state.prompts).toEqual([FIRST_PROMPT, SECOND_PROMPT]);
  expect(controller.state.createDraft).toEqual({ body: "", name: "" });

  controller.beginEdit(FIRST_PROMPT.id);
  expect(controller.state.editDraft).toEqual({
    body: FIRST_PROMPT.body,
    name: FIRST_PROMPT.name,
  });
  controller.setEditField("name", "Updated");
  controller.setEditField("body", "Updated body");
  await controller.saveEdit();
  expect(controller.state.editingId).toBeUndefined();
  expect(controller.state.prompts?.[0]).toMatchObject({
    body: "Updated body",
    name: "Updated",
  });

  controller.select(SECOND_PROMPT.id);
  expect(controller.state.selectedId).toBe(SECOND_PROMPT.id);
  await controller.remove(SECOND_PROMPT.id);
  expect(controller.state.prompts).toHaveLength(1);
  expect(controller.state.selectedId).toBeUndefined();
  expect(requests).toContainEqual({
    body: { body: "Write focused tests.", name: "Tests" },
    method: "POST",
    url: PROMPTS_PATH,
  });
  expect(requests).toContainEqual({
    body: { body: "Updated body", name: "Updated" },
    method: "PUT",
    url: promptPath(FIRST_PROMPT.id),
  });
});

test("validates drafts and presents duplicate-name errors", async () => {
  installFetch((_input, init = {}) => {
    return Promise.resolve(
      init.method === "POST"
        ? Response.json({ error: "duplicate_name" }, { status: 409 })
        : collectionResponse([FIRST_PROMPT]),
    );
  });
  const controller = new PromptController();
  const load = controller.load();
  await load;

  await controller.create();
  expect(controller.state.error).toContain("name and prompt body");

  controller.setCreateField("name", "Inspect");
  controller.setCreateField("body", "A different body");
  await controller.create();
  expect(controller.state.error).toContain("already exists");
});

test("ignores a stale load after the controller resets", async () => {
  let resolveLoad: ((response: Response) => void) | undefined;
  installFetch(
    () =>
      new Promise((resolve) => {
        resolveLoad = resolve;
      }),
  );
  const controller = new PromptController();
  const load = controller.load();

  controller.reset();
  resolveLoad?.(collectionResponse([FIRST_PROMPT]));
  await load;

  expect(controller.state.prompts).toBeUndefined();
});

test("inserts a copy into the session draft without linking future edits", async () => {
  installFetch(() => Promise.resolve(collectionResponse([FIRST_PROMPT])));
  const controller = new PromptController();
  await controller.load();
  controller.select(FIRST_PROMPT.id);

  const inserted: string[] = [];
  controller.insertSelected((body) => {
    inserted.push(body);
  });
  controller.beginEdit(FIRST_PROMPT.id);
  controller.setEditField("body", "Changed after insertion");

  expect(inserted).toEqual([FIRST_PROMPT.body]);
});
