import { Window } from "happy-dom";
import { expect, test } from "vitest";

const FORBIDDEN_ELEMENTS = new Set([
  "animate",
  "animatemotion",
  "animatetransform",
  "audio",
  "embed",
  "foreignobject",
  "iframe",
  "image",
  "link",
  "object",
  "script",
  "set",
  "style",
  "text",
  "textpath",
  "use",
  "video",
]);
const FORBIDDEN_REFERENCE_ATTRIBUTES = new Set([
  "href",
  "src",
  "style",
  "xlink:href",
]);

function svgSource(): Promise<string> {
  return Bun.file(new URL("../favicon.svg", import.meta.url)).text();
}

test("uses a valid, accessible, self-contained square SVG", async () => {
  const source = await svgSource();
  const window = new Window();
  const document = new window.DOMParser().parseFromString(
    source,
    "image/svg+xml",
  );
  const root = document.documentElement;
  const viewBox = root
    .getAttribute("viewBox")
    ?.split(/\s+/u)
    .map((value) => Number(value));

  expect(document.querySelector("parsererror")).toBeNull();
  expect(root.localName).toBe("svg");
  expect(root.namespaceURI).toBe("http://www.w3.org/2000/svg");
  expect(root.getAttribute("role")).toBe("img");
  expect(root.getAttribute("aria-label")).toMatch(/Q Mush/u);
  expect(viewBox).toHaveLength(4);
  expect(viewBox?.slice(0, 2)).toEqual([0, 0]);
  expect(viewBox?.[2]).toBeGreaterThan(0);
  expect(viewBox?.[2]).toBe(viewBox?.[3]);
  expect(source).not.toMatch(/<!doctype|<!entity|@import|url\s*\(/iu);

  for (const element of document.querySelectorAll("*")) {
    expect(FORBIDDEN_ELEMENTS.has(element.localName.toLowerCase())).toBe(false);

    for (const attribute of element.attributes) {
      const name = attribute.name.toLowerCase();
      expect(name.startsWith("on")).toBe(false);
      expect(FORBIDDEN_REFERENCE_ATTRIBUTES.has(name)).toBe(false);
      expect(attribute.value).not.toMatch(/(?:data|javascript):|url\s*\(/iu);
    }
  }
});
