import type { JSX } from "solid-js";
import { render } from "solid-js/web";
import { afterEach, expect, test } from "vitest";
import { mountClientApp } from "../client-mount.ts";

const disposals: (() => void)[] = [];

afterEach(() => {
  while (disposals.length > 0) {
    disposals.pop()?.();
  }
  document.body.textContent = "";
});

function mount(renderApp: () => JSX.Element): HTMLElement {
  const root = document.createElement("main");
  const reconnectShell = document.createElement("section");
  reconnectShell.dataset["offlineShell"] = "true";
  reconnectShell.textContent = "Connection required";
  root.append(reconnectShell);
  document.body.append(root);
  disposals.push(mountClientApp(root, (element) => render(renderApp, element)));
  return root;
}

test("replaces the server reconnect shell without changing the mount root", () => {
  const root = mount(() => (
    <section data-client-app="true">Client app</section>
  ));

  expect(root.tagName).toBe("MAIN");
  expect(root.className).toBe("");
  expect(root.textContent).toBe("Client app");
  expect(root.querySelector("[data-offline-shell]")).toBeNull();
  expect(root.querySelector("[data-client-app]")).not.toBeNull();
});
