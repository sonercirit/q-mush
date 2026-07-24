import { isRecord } from "../shared/auth-model.ts";

const MAXIMUM_OUTPUT_BYTES = 64 * 1_024;
export const MAXIMUM_RESPONSE_BYTES = 16 * 1_024 * 1_024;
const MAXIMUM_LINKS = 200;
const MAXIMUM_METADATA_FIELDS = 100;

export const PAGE_CAPTURE_EXPRESSION = String.raw`(() => {
  const byteLength = (value) => new TextEncoder().encode(value).byteLength;
  const bounded = (value, maximumBytes) => {
    const text = String(value ?? "").trim();
    if (byteLength(text) <= maximumBytes) return text;
    let end = text.length;
    while (end > 0 && byteLength(text.slice(0, end)) > maximumBytes) end -= 1;
    return text.slice(0, end);
  };
  const metadata = {};
  const openGraph = {};
  let metadataTruncated = false;
  const metadataElements = document.querySelectorAll("meta[name], meta[property]");
  for (const element of metadataElements) {
    if (Object.keys(metadata).length + Object.keys(openGraph).length >= ${String(MAXIMUM_METADATA_FIELDS)}) {
      metadataTruncated = true;
      break;
    }
    const name = (element.getAttribute("name") || "").trim().toLowerCase();
    const property = (element.getAttribute("property") || "").trim().toLowerCase();
    const rawContent = String(element.getAttribute("content") ?? "").trim();
    const content = bounded(rawContent, 2048);
    if (!content) continue;
    if (content !== rawContent) metadataTruncated = true;
    if (name === "description" || name === "author" || name === "keywords") {
      if (!(name in metadata)) metadata[name] = content;
    } else if (property.startsWith("og:")) {
      const key = property.slice(3);
      if (key && !(key in openGraph)) openGraph[key] = content;
    }
  }
  if (Object.keys(openGraph).length > 0) metadata.openGraph = openGraph;
  const links = [];
  let linksTruncated = false;
  const seen = new Set();
  for (const element of document.querySelectorAll("a[href]")) {
    const rawHref = element.getAttribute("href");
    let url;
    try { url = new URL(rawHref, document.baseURI); } catch { continue; }
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    if (url.username || url.password || url.hash || String(rawHref).includes("#")) continue;
    const normalized = url.toString();
    if (seen.has(normalized)) continue;
    if (links.length >= ${String(MAXIMUM_LINKS)}) { linksTruncated = true; break; }
    seen.add(normalized);
    links.push({
      text: bounded(element.innerText || element.textContent || element.getAttribute("aria-label") || "", 512),
      url: normalized,
    });
  }
  const source = document.querySelector("main, article, [role='main']") || document.body;
  const rawText = (source?.innerText || source?.textContent || "")
    .replace(/\r/g, "")
    .replace(/[\t ]+\n/g, "\n")
    .replace(/\n[\t ]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const text = bounded(rawText, 49152);
  return {
    links,
    metadata,
    text,
    title: bounded(document.title, 2048),
    truncated: {
      links: linksTruncated,
      metadata: metadataTruncated,
      text: text !== rawText,
    },
  };
})()`;

export interface PageCapture {
  readonly links: readonly { readonly text: string; readonly url: string }[];
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly text: string;
  readonly title: string;
  readonly truncated: {
    readonly links: boolean;
    readonly metadata: boolean;
    readonly text: boolean;
  };
}

export interface PageResponse {
  readonly contentLength: number | undefined;
  readonly contentType: string;
  readonly finalUrl: string;
  readonly status: number;
}

export function responseFromEvent(
  params: unknown,
): (PageResponse & { readonly requestId: string }) | undefined {
  if (
    !isRecord(params) ||
    !isRecord(params["response"]) ||
    typeof params["requestId"] !== "string"
  ) {
    return undefined;
  }
  const response = params["response"];
  const urlValue = response["url"];
  const mimeType = response["mimeType"];
  const status = response["status"];
  if (
    typeof urlValue !== "string" ||
    urlValue.length > 8_192 ||
    typeof mimeType !== "string" ||
    typeof status !== "number" ||
    !Number.isSafeInteger(status)
  ) {
    return undefined;
  }
  const headers = isRecord(response["headers"])
    ? response["headers"]
    : undefined;
  const lengthValue =
    headers?.["content-length"] ?? headers?.["Content-Length"];
  const parsedLength = Number(lengthValue);
  return {
    contentLength:
      Number.isSafeInteger(parsedLength) && parsedLength >= 0
        ? parsedLength
        : undefined,
    contentType: mimeType.toLowerCase(),
    finalUrl: urlValue,
    requestId: params["requestId"],
    status,
  };
}

export function frameFailure(
  params: unknown,
  frameId: string,
): string | undefined {
  if (!isRecord(params) || params["frameId"] !== frameId) {
    return undefined;
  }
  const errorText = params["errorText"];
  return typeof errorText === "string" && errorText.length > 0
    ? errorText
    : "unknown navigation error";
}

function validMetadata(metadata: Readonly<Record<string, unknown>>): boolean {
  return Object.entries(metadata).every(([name, value]) => {
    if (name === "openGraph") {
      return (
        isRecord(value) &&
        Object.keys(value).length <= MAXIMUM_METADATA_FIELDS &&
        Object.values(value).every(
          (entry) =>
            typeof entry === "string" && Buffer.byteLength(entry) <= 2_048,
        )
      );
    }
    return (
      (name === "description" || name === "author" || name === "keywords") &&
      typeof value === "string" &&
      Buffer.byteLength(value) <= 2_048
    );
  });
}

function validLink(
  link: unknown,
): link is { readonly text: string; readonly url: string } {
  if (
    !isRecord(link) ||
    typeof link["text"] !== "string" ||
    Buffer.byteLength(link["text"]) > 512 ||
    typeof link["url"] !== "string" ||
    Buffer.byteLength(link["url"]) > 8_192
  ) {
    return false;
  }
  try {
    const url = new URL(link["url"]);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.username.length === 0 &&
      url.password.length === 0 &&
      url.hash.length === 0
    );
  } catch {
    return false;
  }
}

export function readCapture(value: unknown): PageCapture {
  if (!isRecord(value) || !isRecord(value["result"])) {
    throw new Error("Chromium returned an invalid rendered page result");
  }
  const result = value["result"];
  const capture = result["value"];
  if (
    !isRecord(capture) ||
    typeof capture["text"] !== "string" ||
    Buffer.byteLength(capture["text"]) > 48 * 1_024 ||
    typeof capture["title"] !== "string" ||
    Buffer.byteLength(capture["title"]) > 2_048 ||
    !isRecord(capture["metadata"]) ||
    Object.keys(capture["metadata"]).length > MAXIMUM_METADATA_FIELDS ||
    !validMetadata(capture["metadata"]) ||
    !Array.isArray(capture["links"]) ||
    capture["links"].length > MAXIMUM_LINKS ||
    !isRecord(capture["truncated"]) ||
    typeof capture["truncated"]["links"] !== "boolean" ||
    typeof capture["truncated"]["metadata"] !== "boolean" ||
    typeof capture["truncated"]["text"] !== "boolean"
  ) {
    throw new Error("Chromium returned an invalid rendered page result");
  }
  const links = capture["links"].filter(validLink);
  if (links.length !== capture["links"].length) {
    throw new Error("Chromium returned an invalid rendered page result");
  }
  return {
    links,
    metadata: capture["metadata"],
    text: capture["text"],
    title: capture["title"],
    truncated: {
      links: capture["truncated"]["links"],
      metadata: capture["truncated"]["metadata"],
      text: capture["truncated"]["text"],
    },
  };
}

function truncateUtf8(value: string, maximumBytes: number): string {
  const cropped = Buffer.from(value, "utf8").subarray(0, maximumBytes);
  return cropped.byteLength === Buffer.byteLength(value, "utf8")
    ? value
    : new TextDecoder().decode(cropped);
}

function outputRecord(response: PageResponse, capture: PageCapture) {
  return {
    finalUrl: response.finalUrl,
    links: [...capture.links],
    metadata: capture.metadata,
    status: response.status,
    text: capture.text,
    title: capture.title,
    truncated: {
      links: capture.truncated.links,
      metadata: capture.truncated.metadata,
      output: false,
      text: capture.truncated.text,
    },
  };
}

export function boundedOutput(
  response: PageResponse,
  capture: PageCapture,
): string {
  const result = outputRecord(response, capture);
  let output = JSON.stringify(result, undefined, 2);
  let outputBytes = Buffer.byteLength(output);
  const updateOutput = (): void => {
    output = JSON.stringify(result, undefined, 2);
    outputBytes = Buffer.byteLength(output);
  };
  if (outputBytes <= MAXIMUM_OUTPUT_BYTES) {
    return output;
  }

  result.truncated.output = true;
  while (result.links.length > 0 && outputBytes > MAXIMUM_OUTPUT_BYTES) {
    result.links.pop();
    result.truncated.links = true;
    updateOutput();
  }
  if (outputBytes > MAXIMUM_OUTPUT_BYTES) {
    result.text = truncateUtf8(
      result.text,
      Math.max(
        0,
        Buffer.byteLength(result.text) -
          (outputBytes - MAXIMUM_OUTPUT_BYTES) -
          64,
      ),
    );
    result.truncated.text = true;
    updateOutput();
  }
  if (outputBytes > MAXIMUM_OUTPUT_BYTES) {
    throw new Error("The rendered page metadata exceeds the output limit");
  }
  return output;
}
