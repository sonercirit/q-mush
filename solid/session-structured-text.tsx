import { type JSX } from "solid-js";
import { renderStructuredTextWith } from "./session-code-render.tsx";
import { renderMarkdown } from "./session-markdown-render.tsx";

export { renderPlainText } from "./session-code-render.tsx";

export function renderStructuredText(
  content: string,
  renderText: (text: string) => JSX.Element,
): JSX.Element {
  return renderStructuredTextWith(content, renderText, renderMarkdown);
}
