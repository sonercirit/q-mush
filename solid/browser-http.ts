export class HttpResponseError extends Error {
  readonly code: string | undefined;
  readonly detail: string | undefined;
  readonly status: number;

  constructor(status: number, code?: string, detail?: string) {
    super(`The HTTP request failed with status ${String(status)}`);
    this.code = code;
    this.detail = detail;
    this.name = "HttpResponseError";
    this.status = status;
  }
}

export function hasHttpError(
  error: unknown,
  status: number,
  code?: string,
): boolean {
  return (
    error instanceof HttpResponseError &&
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
    throw new HttpResponseError(response.status, code, detail);
  }

  return response;
}

export async function requestJson(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<unknown> {
  return (await request(input, init)).json();
}
