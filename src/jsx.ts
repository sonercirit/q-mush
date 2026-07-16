export interface JsxElement {
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly children: readonly JsxNode[];
  readonly tagName: string;
}

export type JsxNode =
  | JsxElement
  | readonly JsxNode[]
  | boolean
  | null
  | number
  | string
  | undefined;

declare global {
  // TypeScript requires this namespace name for classic JSX type checking.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    type Element = JsxNode;
    type IntrinsicElements = Record<string, Readonly<Record<string, unknown>>>;
  }
}

const ATTRIBUTE_NAME_PATTERN = /^[A-Za-z][A-Za-z\d:._-]*$/u;
const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

export function createElement(
  tagName: string,
  attributes: Readonly<Record<string, unknown>> | null,
  ...children: readonly JsxNode[]
): JsxElement {
  return { attributes: attributes ?? {}, children, tagName };
}

function escapeText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeAttribute(value: string): string {
  return escapeText(value).replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function normalizeAttributeName(name: string): string {
  if (name === "className") {
    return "class";
  }

  if (name === "htmlFor") {
    return "for";
  }

  return name;
}

function validateName(kind: "attribute" | "tag", name: string): void {
  if (!ATTRIBUTE_NAME_PATTERN.test(name)) {
    throw new TypeError(`Invalid ${kind} name: ${name}`);
  }
}

type AttributeValue = number | string | true;

function visitAttributes(
  attributes: Readonly<Record<string, unknown>>,
  visit: (name: string, value: AttributeValue) => void,
): void {
  for (const [sourceName, value] of Object.entries(attributes)) {
    if (value === false || value === null || value === undefined) {
      continue;
    }

    const name = normalizeAttributeName(sourceName);
    validateName("attribute", name);

    if (
      value !== true &&
      typeof value !== "number" &&
      typeof value !== "string"
    ) {
      throw new TypeError(`Unsupported value for attribute: ${name}`);
    }

    visit(name, value);
  }
}

function renderAttributes(
  attributes: Readonly<Record<string, unknown>>,
): string {
  let html = "";

  visitAttributes(attributes, (name, value) => {
    html +=
      value === true
        ? ` ${name}`
        : ` ${name}="${escapeAttribute(String(value))}"`;
  });

  return html;
}

function isEmptyNode(node: JsxNode): node is boolean | null | undefined {
  return node === null || node === undefined || typeof node === "boolean";
}

function isNodeList(node: JsxNode): node is readonly JsxNode[] {
  return Array.isArray(node);
}

function isTextNode(node: JsxNode): node is number | string {
  return typeof node === "number" || typeof node === "string";
}

export function renderToHtml(node: JsxNode): string {
  if (isEmptyNode(node)) {
    return "";
  }

  if (isTextNode(node)) {
    return escapeText(String(node));
  }

  if (isNodeList(node)) {
    return node.map((child) => renderToHtml(child)).join("");
  }

  validateName("tag", node.tagName);

  const openingTag = `<${node.tagName}${renderAttributes(node.attributes)}>`;

  if (VOID_ELEMENTS.has(node.tagName)) {
    return openingTag;
  }

  return `${openingTag}${renderToHtml(node.children)}</${node.tagName}>`;
}

function setDomAttributes(
  element: globalThis.Element,
  attributes: Readonly<Record<string, unknown>>,
): void {
  visitAttributes(attributes, (name, value) => {
    element.setAttribute(name, value === true ? "" : String(value));
  });
}

function renderToDom(node: JsxNode, ownerDocument: Document): Node {
  if (isEmptyNode(node)) {
    return ownerDocument.createDocumentFragment();
  }

  if (isTextNode(node)) {
    const text = String(node);
    return ownerDocument.createTextNode(text);
  }

  if (isNodeList(node)) {
    const fragment = ownerDocument.createDocumentFragment();

    fragment.append(...node.map((child) => renderToDom(child, ownerDocument)));
    return fragment;
  }

  validateName("tag", node.tagName);

  const element = ownerDocument.createElement(node.tagName);
  setDomAttributes(element, node.attributes);
  element.append(
    ...node.children.map((child) => renderToDom(child, ownerDocument)),
  );

  return element;
}

export function mount(node: JsxNode, container: globalThis.Element): void {
  container.replaceChildren(renderToDom(node, container.ownerDocument));
}
