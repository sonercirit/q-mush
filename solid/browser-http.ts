export interface HttpResponseError extends Error {
  readonly code: string | undefined;
  readonly detail: string | undefined;
  readonly kind: "http_response_error";
  readonly status: number;
}

export function createHttpResponseError(
  status: number,
  code?: string,
  detail?: string,
): HttpResponseError {
  return Object.assign(
    new Error(`The HTTP request failed with status ${String(status)}`),
    { code, detail, kind: "http_response_error" as const, status },
  );
}

export function isHttpResponseError(error: unknown): error is HttpResponseError {
  return (
    error instanceof Error &&
    "kind" in error &&
    error.kind === "http_response_error" &&
    "status" in error &&
    typeof error.status === "number"
  );
}

export function hasHttpError(
  error: unknown,
  status: number,
  code?: string,
): boolean {
  return (
    isHttpResponseError(error) &&
    error.status === status &&
    (code === undefined || error.code === code)
  );
}

export function hasHttpStatus(error: unknown, status: number): boolean {
  return hasHttpError(error, status);
}

function errorDetails(value: unknown): {
  readonly code: string | undefined;
  readonly detail: string | undefined;
} {
  if (typeof value !== "object" || value === null || !("error" in value)) {
    return { code: undefined, detail: undefined };
  }
  const error: unknown = value.error;
  const message: unknown = "message" in value ? value.message : undefined;
  return {
    code: typeof error === "string" ? error : undefined,
    detail: typeof message === "string" ? message : undefined,
  };
}

export async function request(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);

  if (!headers.has("accept")) {
    headers.set("accept", "application/json");
  }

  const response = await fetch(input, { ...init, headers });

  if (!response.ok) {
    let code: string | undefined;
    let detail: string | undefined;
    try {
      const value: unknown = await response.clone().json();
      ({ code, detail } = errorDetails(value));
    } catch {
      // Not every failed response has a JSON API body.
    }
    throw createHttpResponseError(response.status, code, detail);
  }

  return response;
}

export async function requestJson(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<unknown> {
  return (await request(input, init)).json();
}
