import { render } from "solid-js/web";
import { afterEach, expect, test } from "vitest";
import { PwaController } from "../pwa-controller.tsx";

interface MountedController {
  readonly container: HTMLElement;
  readonly dispose: () => void;
}

const mounted: MountedController[] = [];
const offlineStates: boolean[] = [];
function onOfflineChange(offline: boolean): void {
  offlineStates.push(offline);
}
function onOnline(): Promise<boolean> {
  return Promise.resolve(true);
}

function mountController(): MountedController {
  const container = document.body.appendChild(document.createElement("aside"));
  const dispose = render(
    () => (
      <PwaController onOfflineChange={onOfflineChange} onOnline={onOnline} />
    ),
    container,
  );
  const result = { container, dispose };
  mounted.push(result);
  return result;
}

afterEach(() => {
  offlineStates.length = 0;
  for (const controller of mounted.splice(0)) {
    controller.dispose();
    controller.container.remove();
  }
});

test("mounts conservatively when service workers are unsupported", async () => {
  const { container } = mountController();
  await Promise.resolve();

  expect(container.textContent).not.toContain("Update available");
  expect(container.textContent).not.toContain("Install app");
});

test("removes browser lifecycle listeners on disposal", async () => {
  const controller = mountController();
  await Promise.resolve();
  controller.dispose();
  mounted.splice(mounted.indexOf(controller), 1);
  controller.container.remove();

  window.dispatchEvent(new Event("offline"));
  window.dispatchEvent(new Event("online"));
  await Promise.resolve();

  expect(controller.container.textContent).toBe("");
});
