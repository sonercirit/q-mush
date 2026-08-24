import { afterEach, expect, test } from "vitest";
import { createReactiveState } from "../reactive-state.ts";
import {
  createRunnerViewState,
  RunnerPanel,
  type RunnerViewState,
} from "../runner-client.tsx";
import {
  createRunnerController,
  type RunnerController,
} from "../runner-controller.ts";
import {
  expectTestText,
  findTestButton,
  mountTestView,
} from "./dom-test-helpers.ts";
import { runnerSummary } from "./runner-fixtures.ts";

const disposals: (() => void)[] = [];

function mountRunnerPanel(): Readonly<{
  container: HTMLDivElement;
  controller: RunnerController;
}> {
  const reactive = createReactiveState<RunnerViewState>(
    createRunnerViewState([runnerSummary(1)]),
  );
  const controller = createRunnerController(reactive);
  return {
    container: mountTestView(
      () => <RunnerPanel controller={controller} />,
      disposals,
    ),
    controller,
  };
}

function stubFetch(request: () => Promise<Response>): void {
  const fetchToRestore = globalThis.fetch;
  Reflect.set(globalThis, "fetch", request);
  disposals.push(() => {
    Reflect.set(globalThis, "fetch", fetchToRestore);
  });
}

afterEach(() => {
  while (disposals.length > 0) {
    disposals.pop()?.();
  }
  document.body.replaceChildren();
});

test("runner removal applies its realtime snapshot and clears busy state without refetch", async () => {
  const { container, controller } = mountRunnerPanel();
  const request = Promise.withResolvers<Response>();
  let requests = 0;
  stubFetch(() => {
    requests += 1;
    return request.promise;
  });

  findTestButton(container, "Remove")?.click();
  expect(controller.state.removingId).toBe("runner-1");
  expect(container.textContent).toContain("Removing…");
  controller.applyRealtime([]);
  expect(container.textContent).toContain("workstation");

  request.resolve(new Response());
  await expectTestText(container, "No runners yet");
  expect(controller.state.removingId).toBeUndefined();
  expect(requests).toBe(1);
});

test("runner removal failure clears its busy state", async () => {
  const { container, controller } = mountRunnerPanel();
  stubFetch(() =>
    Promise.resolve(Response.json({ error: "failure" }, { status: 500 })),
  );

  findTestButton(container, "Remove")?.click();
  await expectTestText(container, "We could not remove that runner.");

  expect(findTestButton(container, "Remove")?.disabled).toBe(false);
  expect(controller.state.removingId).toBeUndefined();
});
