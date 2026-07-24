/* cpd-ignore-start -- deterministic MutationObserver DOM harness */
import { render } from "solid-js/web";
import { expect, test } from "vitest";
import {
  appendElement,
  appRoot,
  createHarness,
  DebugControls,
  element,
  emitMutation,
  enabledHarness,
  expectDetached,
  expectHighlight,
  expectUiState,
  highlight,
  highlights,
  registerCleanup,
  verifyHarness,
} from "./render-debug-dom-helpers.tsx";
import { createMutationRecord } from "./render-debug-test-helpers.ts";

test("does no observer or overlay work while off and highlights every static element when enabled", () => {
  const root = appRoot();
  const section = appendElement(root, "section", "static-section");
  appendElement(section, "span", "static-child");
  const harness = createHarness(root);
  expectDetached(harness);
  harness.debug.toggle();
  harness.frames.flush();
  verifyHarness(harness, { attached: true, enabled: true });
  expectHighlight("div#test-app", "initial");
  expectHighlight("section#static-section", "initial");
  expectHighlight("span#static-child", "initial");
});
test("automatically highlights dynamically inserted elements and their descendants", () => {
  const root = appRoot();
  const harness = enabledHarness(root);
  const dynamic = document.createElement("article");
  dynamic.id = "dynamic";
  appendElement(dynamic, "strong", "dynamic-child");
  root.append(dynamic);
  emitMutation(
    harness,
    createMutationRecord({
      addedNodes: [dynamic],
      target: root,
      type: "childList",
    }),
    16,
  );
  expectHighlight("article#dynamic", "insert");
  expectHighlight("strong#dynamic-child", "insert");
});
test("automatically instruments modal portals outside the app root", () => {
  const root = appRoot();
  const harness = enabledHarness(root);
  const portal = appendElement(document.body, "dialog", "portal-modal");
  emitMutation(
    harness,
    createMutationRecord({
      addedNodes: [portal],
      target: document.body,
      type: "childList",
    }),
    24,
  );
  expect(harness.observer.observe).toHaveBeenCalledWith(
    document.body,
    expect.any(Object),
  );
  expectHighlight("dialog#portal-modal", "insert");
});
test("highlights text changes on their nearest element", () => {
  const root = appRoot();
  const paragraph = appendElement(root, "p", "copy");
  const copy = document.createTextNode("Before");
  paragraph.append(copy);
  const harness = enabledHarness(root);
  expect(harness.observer.observe).toHaveBeenCalledWith(document.body, {
    attributes: true,
    characterData: true,
    childList: true,
    subtree: true,
  });
  copy.data = "After";
  emitMutation(
    harness,
    createMutationRecord({ target: copy, type: "characterData" }),
    32,
  );
  expect(expectHighlight("p#copy", "text").textContent).toContain("text");
});
test("highlights text nodes inserted during keyed updates", () => {
  const root = appRoot();
  const output = appendElement(root, "p", "keyed-output");
  const harness = enabledHarness(root);
  const text = document.createTextNode("Streamed text");
  output.append(text);
  emitMutation(
    harness,
    createMutationRecord({
      addedNodes: [text],
      target: output,
      type: "childList",
    }),
    32,
  );
  const updated = expectHighlight("p#keyed-output", "text");
  expect(updated.classList.contains("render-debug-highlight--insert")).toBe(
    false,
  );
});
test("uses bounded structural labels without exposing content or form values", () => {
  const root = appRoot();
  const input = appendElement(root, "input", "");
  input.setAttribute("aria-label", "Provider credential");
  input.value = "super-secret-token";
  enabledHarness(root);
  expectHighlight("input “Provider credential”", "initial");
  expect(
    document.querySelector("#render-debug-overlay")?.textContent,
  ).not.toContain("super-secret-token");
});
test("does not report sensitive value attributes", () => {
  const root = appRoot();
  const input = appendElement(root, "input", "api-key");
  const harness = enabledHarness(root);
  for (const highlight of highlights()) {
    highlight.dispatchEvent(new Event("animationend"));
  }
  input.setAttribute("value", "super-secret-token");
  harness.observer.records([
    createMutationRecord({
      attributeName: "value",
      target: input,
      type: "attributes",
    }),
  ]);
  harness.frames.flush(48);
  expect(highlight("input#api-key")).toBeUndefined();
  expect(
    document.querySelector("#render-debug-overlay")?.textContent,
  ).not.toContain("super-secret-token");
});
test("highlights attribute changes on the changed element", () => {
  const root = appRoot();
  const button = appendElement(root, "button", "save");
  const harness = enabledHarness(root);
  button.setAttribute("aria-pressed", "true");
  emitMutation(
    harness,
    createMutationRecord({
      attributeName: "aria-pressed",
      target: button,
      type: "attributes",
    }),
    48,
  );
  expect(expectHighlight("button#save", "attribute").textContent).toContain(
    "aria-pressed",
  );
});
test("highlights the surviving parent when a child is removed", () => {
  const root = appRoot();
  const list = appendElement(root, "ul", "items");
  const item = appendElement(list, "li", "removed-item");
  const harness = enabledHarness(root);
  item.remove();
  emitMutation(
    harness,
    createMutationRecord({
      removedNodes: [item],
      target: list,
      type: "childList",
    }),
    64,
  );
  expectHighlight("ul#items", "remove");
  expect(highlight("li#removed-item")).toBeUndefined();
});
test("the toggle attaches and cleans up without changing app order, focus, or scroll", () => {
  const root = appRoot();
  const scrollTop = 37;
  root.scrollTop = scrollTop;
  const harness = createHarness(root);
  const dispose = render(() => <DebugControls debug={harness.debug} />, root);
  registerCleanup(dispose);
  const input = element("input");
  const toggle = element("button");
  const appChildren = [...root.childNodes];
  input.focus();
  toggle.click();
  harness.frames.flush();
  expect(toggle.getAttribute("aria-pressed")).toBe("true");
  expectUiState({ children: appChildren, focused: input, root, scrollTop });
  expectHighlight("button", "initial");
  toggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  expect(toggle.getAttribute("aria-pressed")).toBe("false");
  expect(harness.observer.disconnect).toHaveBeenCalledOnce();
  expect(document.querySelector("#render-debug-overlay")).toBeNull();
  expectUiState({ children: appChildren, focused: input, root, scrollTop });
  input.setAttribute("aria-label", "Changed while disabled");
  expect(harness.frames.pending()).toBe(0);
});
/* cpd-ignore-end -- deterministic MutationObserver DOM harness */
