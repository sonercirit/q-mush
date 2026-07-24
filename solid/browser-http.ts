export class HttpResponseError extends Error {
  readonly code: string | undefined;
  readonly status: number;

  constructor(status: number, code?: string) {
    super(`The HTTP request failed with status ${String(status)}`);
    this.code = code;
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
    try {
      const value: unknown = await response.clone().json();
      code =
        typeof value === "object" &&
        value !== null &&
        "error" in value &&
        typeof value.error === "string"
          ? value.error
          : undefined;
    } catch {
      // Not every failed response has a JSON API body.
    }
    throw new HttpResponseError(response.status, code);
  }

  return response;
}

export async function requestJson(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<unknown> {
  return (await request(input, init)).json();
}
