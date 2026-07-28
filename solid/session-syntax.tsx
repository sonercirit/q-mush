import { type JSX } from "solid-js";
import {
  renderHighlightedCodeWith,
  renderStructuredCodeWith,
} from "./session-code-render.tsx";
import { renderMarkdown } from "./session-markdown-render.tsx";

export function renderHighlightedCode(
  code: string,
  language: string | undefined,
  classes?: string,
): JSX.Element {
  return renderHighlightedCodeWith(code, language, renderMarkdown, classes);
}

export function renderStructuredCode(
  content: string,
  classes?: string,
): JSX.Element {
  return renderStructuredCodeWith(content, renderMarkdown, classes);
}
