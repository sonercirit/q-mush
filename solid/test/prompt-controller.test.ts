import { afterEach, expect, test } from "vitest";
import { PROMPTS_PATH } from "../../shared/routes.ts";
import { PromptController } from "../../solid/prompt-controller.ts";
import { createPromptViewState } from "../../solid/prompt-state.ts";
import { createReactiveState } from "../../solid/reactive-state.ts";
import { installTestFetch, requestUrl } from "./controller-test-helpers.ts";
import { TEST_PROMPT } from "./prompt-fixtures.ts";

const FIRST = {
  ...TEST_PROMPT,
  body: "Inspect the repository.",
  createdAt: 1,
  id: "prompt-1",
  name: "Inspect",
  revision: 1,
  updatedAt: 1,
};
const SECOND = {
  body: "Write focused tests.",
  createdAt: 2,
  id: "prompt-2",
  name: "Tests",
  revision: 1,
  updatedAt: 2,
};
const CHANGED_ERROR =
  "That prompt changed in another window. Your draft was not saved.";
let restoreFetch: (() => void) | undefined;

afterEach(() => {
  restoreFetch?.();
  restoreFetch = undefined;
});

function collection(prompts: readonly (typeof FIRST)[]): Response {
  return Response.json({ prompts });
}

function install(
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

function deferred() {
  let settle: ((response: Response) => void) | undefined;
  const response = new Promise<Response>((resolve) => {
    settle = resolve;
  });
  return { response, settle: (value: Response) => settle?.(value) };
}

async function loadController(): Promise<PromptController> {
  const controller = new PromptController();
  await controller.load();
  return controller;
}

function editStaleDraft(controller: PromptController): void {
  controller.beginEdit(FIRST.id);
  controller.setEditField("body", "My stale change");
}

function changedResponse(): Response {
  return Response.json({ error: "prompt_changed" }, { status: 412 });
}

function setSecondDraft(controller: PromptController): void {
  controller.setCreateField("name", SECOND.name);
  controller.setCreateField("body", SECOND.body);
}

interface ConflictFetchOptions {
  readonly method: "DELETE" | "PUT";
  readonly refresh?: ReturnType<typeof deferred>;
  readonly refreshedPrompt?: typeof FIRST;
  readonly rejectRefresh?: boolean;
  readonly started?: () => void;
}

function installConflictFetch(options: ConflictFetchOptions): void {
  let reads = 0;
  install((_input, init = {}) => {
    if (init.method === options.method) {
      return Promise.resolve(changedResponse());
    }
    reads += 1;
    if (reads === 1) {
      return Promise.resolve(collection([FIRST]));
    }
    options.started?.();
    if (options.rejectRefresh === true) {
      return Promise.reject(new Error("refresh failed"));
    }
    if (options.refresh !== undefined) {
      return options.refresh.response;
    }
    return Promise.resolve(collection([options.refreshedPrompt ?? FIRST]));
  });
}

interface ConflictResult {
  readonly busy: boolean;
  readonly editBody: string | undefined;
  readonly error: string | undefined;
  readonly prompts: readonly (typeof FIRST)[] | undefined;
}

function conflictResult(controller: PromptController): ConflictResult {
  return {
    busy: controller.state.removingId !== undefined || controller.state.saving,
    editBody:
      controller.state.editingId === undefined
        ? undefined
        : controller.state.editDraft.body,
    error: controller.state.error,
    prompts: controller.state.prompts,
  };
}

async function controllerWithStaleEdit(): Promise<PromptController> {
  const controller = await loadController();
  editStaleDraft(controller);
  return controller;
}

test("loads, creates, edits, deletes, and sends revisions", async () => {
  const revisions: (string | null)[] = [];
  let prompts = [FIRST];
  install((input, init = {}) => {
    const method = init.method ?? "GET";
    if (method === "PUT" || method === "DELETE") {
      revisions.push(new Headers(init.headers).get("if-match"));
    }
    if (requestUrl(input) === PROMPTS_PATH && method === "GET") {
      return Promise.resolve(collection(prompts));
    }
    if (method === "POST") {
      prompts = [...prompts, SECOND];
      return Promise.resolve(Response.json(SECOND, { status: 201 }));
    }
    if (method === "PUT") {
      const changed = {
        ...FIRST,
        body: "Updated body",
        name: "Updated",
        revision: 2,
      };
      prompts = [changed, SECOND];
      return Promise.resolve(Response.json(changed));
    }
    prompts = prompts.filter(({ id }) => id !== SECOND.id);
    return Promise.resolve(new Response(null, { status: 204 }));
  });

  const controller = await loadController();
  setSecondDraft(controller);
  await controller.create();
  expect(controller.state.prompts).toEqual([FIRST, SECOND]);
  expect(controller.state.createDraft).toEqual({ body: "", name: "" });

  controller.beginEdit(FIRST.id);
  controller.setEditField("name", "Updated");
  controller.setEditField("body", "Updated body");
  await controller.saveEdit();
  expect(controller.state.prompts?.[0]?.body).toBe("Updated body");

  controller.select(SECOND.id);
  await controller.remove(SECOND.id);
  expect(controller.state.selectedId).toBeUndefined();
  expect(revisions).toEqual(['"1"', '"1"']);
});

test("validates drafts and distinguishes duplicate and limit errors", async () => {
  let code = "duplicate_name";
  install((_input, init = {}) =>
    Promise.resolve(
      init.method === "POST"
        ? Response.json({ error: code }, { status: 409 })
        : collection([FIRST]),
    ),
  );
  const controller = await loadController();
  await controller.create();
  const emptyDraftError = controller.state.error;

  controller.setCreateField("name", "Inspect");
  controller.setCreateField("body", "A different body");
  await controller.create();
  const duplicateError = controller.state.error;
  code = "prompt_limit_reached";
  await controller.create();
  expect({
    duplicateError,
    emptyDraftError,
    limitState: controller.state,
  }).toMatchObject({
    duplicateError: "A prompt with that name already exists.",
    emptyDraftError: "Enter a name and prompt body before saving.",
    limitState: {
      createDraft: { body: "A different body", name: "Inspect" },
      error:
        "You have reached the limit of 100 saved prompts. Delete one before saving another.",
    },
  });
});

test("ignores pending and overlapping loads after reset", async () => {
  const pending = deferred();
  let fetchCount = 0;
  install(() => {
    fetchCount += 1;
    return pending.response;
  });
  const controller = new PromptController();
  const firstLoad = controller.load();
  await controller.load();
  controller.reset();
  pending.settle(collection([FIRST]));
  await firstLoad;
  expect({ fetchCount, state: controller.state }).toEqual({
    fetchCount: 1,
    state: createPromptViewState(undefined),
  });
});

test("does not let create race with an active load or mutation", async () => {
  const pending = deferred();
  const methods: string[] = [];
  install((_input, init = {}) => {
    const method = init.method ?? "GET";
    methods.push(method);
    return method === "GET"
      ? pending.response
      : Promise.resolve(Response.json(SECOND));
  });
  const controller = new PromptController(
    createReactiveState(createPromptViewState([])),
  );
  setSecondDraft(controller);
  const loading = controller.load();
  await controller.create();
  expect(methods).toEqual(["GET"]);
  pending.settle(collection([FIRST]));
  await loading;
  expect(controller.state.prompts).toEqual([FIRST]);

  const post = deferred();
  install((_input, init = {}) =>
    init.method === "POST"
      ? post.response
      : Promise.resolve(collection([FIRST])),
  );
  setSecondDraft(controller);
  const creating = controller.create();
  await controller.remove(FIRST.id);
  post.settle(Response.json(SECOND, { status: 201 }));
  await creating;
  expect(controller.state.prompts).toEqual([FIRST, SECOND]);
});

test("reset during edit conflict refresh stays reset", async () => {
  const refresh = deferred();
  let announce: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    announce = resolve;
  });
  installConflictFetch({
    method: "PUT",
    refresh,
    started: () => announce?.(),
  });
  const controller = await controllerWithStaleEdit();
  const saving = controller.saveEdit();
  await started;
  controller.reset();
  refresh.settle(
    collection([{ ...FIRST, body: "Changed elsewhere", revision: 2 }]),
  );
  await saving;
  expect(controller.state).toEqual(createPromptViewState(undefined));
});

test("reset during delete conflict refresh stays reset", async () => {
  const refresh = deferred();
  let beginRefresh: (() => void) | undefined;
  const refreshing = new Promise<void>((resolve) => {
    beginRefresh = resolve;
  });
  installConflictFetch({
    method: "DELETE",
    refresh,
    started: () => beginRefresh?.(),
  });
  const controller = await loadController();
  const removing = controller.remove(FIRST.id);
  await refreshing;
  controller.reset();
  refresh.settle(collection([{ ...FIRST, revision: 2 }]));
  await removing;
  expect(controller.state).toMatchObject({
    error: undefined,
    prompts: undefined,
  });
});

test("failed edit conflict refresh settles and preserves draft", async () => {
  installConflictFetch({ method: "PUT", rejectRefresh: true });
  const controller = await controllerWithStaleEdit();
  await controller.saveEdit();
  expect(conflictResult(controller)).toEqual({
    busy: false,
    editBody: "My stale change",
    error: CHANGED_ERROR,
    prompts: [FIRST],
  });
});

test("failed delete conflict refresh settles", async () => {
  installConflictFetch({ method: "DELETE", rejectRefresh: true });
  const controller = await loadController();
  await controller.remove(FIRST.id);
  expect(conflictResult(controller)).toEqual({
    busy: false,
    editBody: undefined,
    error: CHANGED_ERROR,
    prompts: [FIRST],
  });
});

test("reloads changed prompts while retaining a stale edit", async () => {
  const changed = { ...FIRST, body: "Changed elsewhere", revision: 2 };
  installConflictFetch({ method: "PUT", refreshedPrompt: changed });
  const controller = await controllerWithStaleEdit();
  await controller.saveEdit();
  const result = conflictResult(controller);
  expect([result.editBody, result.prompts]).toEqual([
    "My stale change",
    [changed],
  ]);
});

test("inserts a copy without linking later edits", async () => {
  install(() => Promise.resolve(collection([FIRST])));
  const controller = await loadController();
  controller.select(FIRST.id);
  const inserted: string[] = [];
  controller.insertSelected((body) => {
    inserted.push(body);
    return true;
  });
  controller.beginEdit(FIRST.id);
  controller.setEditField("body", "Changed after insertion");
  expect(inserted).toEqual([FIRST.body]);
});
