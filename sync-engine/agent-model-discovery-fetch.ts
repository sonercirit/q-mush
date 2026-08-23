import { executeWithAbortSignal } from "../shared/validation.ts";
import { cancelableResponseReader } from "./cancelable-response-reader.ts";
import { isProviderCredentialRejection } from "./provider-error.ts";

const MAXIMUM_RESPONSE_LENGTH = 5 * 1024 * 1024;
const MODEL_CATALOG_TOO_LARGE = "The provider model catalog was too large";

export type AgentModelDiscoveryFetch = (request: Request) => Promise<Response>;

export interface AgentModelDiscoveryError extends Error {
  readonly status: number | undefined;
}

const agentModelDiscoveryErrors = new WeakSet<object>();

export function isAgentModelDiscoveryError(
  error: unknown,
): error is AgentModelDiscoveryError {
  return error instanceof Error && agentModelDiscoveryErrors.has(error);
}

export const AgentModelDiscoveryError = Object.defineProperty(
  function AgentModelDiscoveryError(
    message: string,
    status?: number,
  ): AgentModelDiscoveryError {
    const error = Object.assign(new Error(message), {
      name: "AgentModelDiscoveryError",
      status,
    });
    agentModelDiscoveryErrors.add(error);
    return error;
  },
  Symbol.hasInstance,
  { value: isAgentModelDiscoveryError },
);

export function isCredentialRejectionError(error: unknown): boolean {
  return (
    isProviderCredentialRejection(error) ||
    (isAgentModelDiscoveryError(error) &&
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
  return AgentModelDiscoveryError(message, status);
}

export function safeAgentModelDiscoveryError(error: unknown): string {
  return isAgentModelDiscoveryError(error)
    ? error.message
    : "Model discovery failed because the provider is unavailable";
}

function nextResponseChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
  cancellation: ReturnType<typeof cancelableResponseReader>,
): ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]> {
  return executeWithAbortSignal(
    signal,
    cancellation.options("Model discovery was canceled"),
    () => reader.read(),
  );
}

async function appendResponseChunk(
  cancel: () => Promise<void>,
  target: Uint8Array,
  offset: number,
  value: Uint8Array,
): Promise<number> {
  const nextOffset = offset + value.byteLength;
  if (nextOffset > MAXIMUM_RESPONSE_LENGTH) {
    await cancel();
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
  const responseReader = cancelableResponseReader(reader);
  const bytes = Buffer.allocUnsafe(MAXIMUM_RESPONSE_LENGTH);
  let length = 0;
  let reading = true;
  try {
    while (reading) {
      const part = await nextResponseChunk(reader, signal, responseReader);
      reading = !part.done;
      if (!part.done) {
        length = await appendResponseChunk(
          responseReader.cancel,
          bytes,
          length,
          part.value,
        );
      }
    }
  } finally {
    responseReader.release(signal);
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
