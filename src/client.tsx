import { createElement, mount, type JsxNode } from "./jsx.ts";
import { HOME_PATH } from "./routes.ts";

function renderApp(actionCount: number): JsxNode {
  return (
    <section aria-labelledby="app-title">
      <h1 id="app-title">Q Mush App</h1>
      <p>
        This interface was rendered in your browser with framework-free TSX.
      </p>
      <p aria-live="polite">Actions run: {actionCount}</p>
      <button type="button">Run an action</button>
      <a href={HOME_PATH}>Back to the homepage</a>
    </section>
  );
}

const root = document.querySelector("#app");

if (root === null) {
  throw new Error("The app root was not found");
}

let actionCount = 0;

function updateApp(container: Element): void {
  mount(renderApp(actionCount), container);

  const button = container.querySelector("button");

  if (button === null) {
    throw new Error("The app action button was not rendered");
  }

  button.addEventListener("click", () => {
    actionCount += 1;
    updateApp(container);
  });
}

updateApp(root);
