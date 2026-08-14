import { executeWithAbortSignal } from "../shared/validation.ts";
import { isProviderCredentialRejection } from "./provider-error.ts";

const MAXIMUM_RESPONSE_LENGTH = 5 * 1024 * 1024;
const MODEL_CATALOG_TOO_LARGE = "The provider model catalog was too large";

export type AgentModelDiscoveryFetch = (request: Request) => Promise<Response>;

export class AgentModelDiscoveryError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "AgentModelDiscoveryError";
    this.status = status;
  }
}

export function isCredentialRejectionError(error: unknown): boolean {
  return (
    isProviderCredentialRejection(error) ||
    (error instanceof AgentModelDiscoveryError &&
      (error.status === 401 ||
        error.status === 402 ||
        error.status === 403 ||
        error.status === 429))
  );
}

export function modelDiscoveryError(
  message: string,
  status?: number,
): AgentModelDiscoveryError {
  return new AgentModelDiscoveryError(message, status);
}

export function safeAgentModelDiscoveryError(error: unknown): string {
  return error instanceof AgentModelDiscoveryError
    ? error.message
    : "Model discovery failed because the provider is unavailable";
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  void reader.cancel().catch(() => undefined);
}

function nextResponseChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]> {
  return executeWithAbortSignal(
    signal,
    {
      abortMessage: "Model discovery was canceled",
      onAbort: () => {
        cancelReader(reader);
      },
    },
    () => reader.read(),
  );
}

function appendResponseChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  target: Uint8Array,
  offset: number,
  value: Uint8Array,
): number {
  const nextOffset = offset + value.byteLength;
  if (nextOffset > MAXIMUM_RESPONSE_LENGTH) {
    cancelReader(reader);
    throw modelDiscoveryError(MODEL_CATALOG_TOO_LARGE);
  }
  target.set(value, offset);
  return nextOffset;
}

async function readProviderResponse(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  const status = response.status;
  if (!response.ok) {
    throw modelDiscoveryError(
      `Model discovery failed with status ${String(status)}`,
      status,
    );
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAXIMUM_RESPONSE_LENGTH
  ) {
    throw modelDiscoveryError(MODEL_CATALOG_TOO_LARGE);
  }
  const reader = response.body?.getReader();
  if (reader === undefined) return null;
  const bytes = Buffer.allocUnsafe(MAXIMUM_RESPONSE_LENGTH);
  let length = 0;
  let reading = true;
  try {
    while (reading) {
      const part = await nextResponseChunk(reader, signal);
      reading = !part.done;
      if (!part.done) {
        length = appendResponseChunk(reader, bytes, length, part.value);
      }
    }
  } finally {
    reader.releaseLock();
  }
  try {
    const body = new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(0, length),
    );
    const value: unknown = JSON.parse(body);
    return value;
  } catch {
    throw modelDiscoveryError("The provider returned an invalid model catalog");
  }
}

export async function fetchDiscoveryJson(
  fetch: AgentModelDiscoveryFetch,
  url: URL | string,
  headers: Headers,
  signal?: AbortSignal,
): Promise<unknown> {
  const timeout = AbortSignal.timeout(10_000);
  const combined =
    signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
  const response = await executeWithAbortSignal(
    combined,
    {
      abortMessage: "Model discovery was canceled",
      failureMessage: "Model discovery failed",
    },
    () =>
      fetch(
        new Request(url, {
          headers,
          method: "GET",
          signal: combined,
        }),
      ),
  );
  return readProviderResponse(response, combined);
}
