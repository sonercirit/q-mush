import { expect, test } from "vitest";
import type { ToolSettings } from "../../shared/tool-limits.ts";
import { createReactiveState } from "../reactive-state.ts";
import { ToolSettingsPanel } from "../tool-settings-client.tsx";
import {
  createToolSettingsController,
  type ToolSettingsController,
  type ToolSettingsViewState,
} from "../tool-settings-controller.ts";
import {
  installFetch,
  restoreFetchAfterEach,
} from "./controller-test-helpers.ts";
import {
  mountTestView,
  queryTestElementAs,
  setTestInputValue,
} from "./dom-test-helpers.ts";
import { trackedDisposals } from "./nested-scroll-test-helpers.tsx";

const disposals = trackedDisposals();
restoreFetchAfterEach();

function loadedState(settings: ToolSettings): ToolSettingsViewState {
  return { error: undefined, loading: false, saving: false, settings };
}

function settingsController(settings: ToolSettings): ToolSettingsController {
  return createToolSettingsController(createReactiveState(loadedState(settings)));
}

function testSettings(
  executionLimitMinutes: number,
  outputLimitCharacters: number,
): ToolSettings {
  return { executionLimitMinutes, outputLimitCharacters };
}

async function loadedController(): Promise<ToolSettingsController> {
  const controller = createToolSettingsController();
  await controller.load();
  return controller;
}

test("loads, saves, applies realtime settings, and resets per user", async () => {
  const requests: { readonly body: unknown; readonly method: string }[] = [];
  installFetch((_input, init = {}) => {
    requests.push({
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
      method: init.method ?? "GET",
    });
    return Promise.resolve(
      Response.json(
        init.method === "PUT" ? testSettings(8, 9_000) : testSettings(4, 5_000),
      ),
    );
  });
  const controller = await loadedController();

  expect(controller.settings).toEqual(testSettings(4, 5_000));
  await controller.save(testSettings(8, 9_000));
  controller.apply(testSettings(2, 3_000));
  expect(controller.settings).toEqual(testSettings(2, 3_000));
  controller.reset();
  expect(controller.view()).toMatchObject({
    loading: true,
    settings: undefined,
  });
  expect(requests).toEqual([
    { body: undefined, method: "GET" },
    { body: testSettings(8, 9_000), method: "PUT" },
  ]);
});

test("realtime invalidates pending load and save responses", async () => {
  const load = Promise.withResolvers<Response>();
  const save = Promise.withResolvers<Response>();
  installFetch((_input, init = {}) =>
    init.method === "PUT" ? save.promise : load.promise,
  );
  const controller = createToolSettingsController();
  const loading = controller.load();
  const realtimeAfterLoad = testSettings(6, 6_000);
  controller.apply(realtimeAfterLoad);
  load.resolve(Response.json(testSettings(2, 2_000)));
  await loading;
  expect(controller.settings).toEqual(realtimeAfterLoad);

  const saving = controller.save(testSettings(7, 7_000));
  const realtimeAfterSave = testSettings(9, 9_000);
  controller.apply(realtimeAfterSave);
  save.resolve(Response.json(testSettings(7, 7_000)));
  await saving;
  expect(controller.settings).toEqual(realtimeAfterSave);
});

test("load failure leaves settings unavailable instead of claiming defaults", async () => {
  installFetch(() => Promise.resolve(Response.json({}, { status: 503 })));
  const controller = await loadedController();

  expect(controller.view()).toMatchObject({
    error: "We could not load your tool limits.",
    loading: false,
    settings: undefined,
  });
});

test("edits and saves both limits without clobbering a draft on realtime", async () => {
  const saved = Promise.withResolvers<undefined>();
  let savedBody: unknown;
  installFetch((_input, init = {}) => {
    savedBody =
      typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    saved.resolve(undefined);
    return Promise.resolve(Response.json(savedBody));
  });
  const controller = settingsController(testSettings(4, 5_000));
  const container = mountTestView(
    () => <ToolSettingsPanel controller={controller} />,
    disposals,
  );
  const execution = queryTestElementAs(
    container,
    "#tool-execution-limit",
    HTMLInputElement,
  );
  const output = queryTestElementAs(
    container,
    "#tool-output-limit",
    HTMLInputElement,
  );

  setTestInputValue(execution, "7");
  controller.apply(testSettings(6, 6_000));
  expect(execution.value).toBe("7");
  expect(output.value).toBe("5000");
  setTestInputValue(output, "7000");
  queryTestElementAs(container, "button", HTMLButtonElement).click();
  await saved.promise;
  expect(savedBody).toEqual(testSettings(7, 7_000));
});
