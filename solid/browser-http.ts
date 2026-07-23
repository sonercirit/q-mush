export class HttpResponseError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`The HTTP request failed with status ${String(status)}`);
    this.name = "HttpResponseError";
    this.status = status;
  }
}

export async function request(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);

  if (!headers.has("accept")) {
    headers.set("accept", "application/json");
  }

  const response = await fetch(input, {
    ...init,
    cache: init.cache ?? "no-store",
    headers,
  });

  if (!response.ok) {
    throw new HttpResponseError(response.status);
  }

  return response;
}

export async function requestJson(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<unknown> {
  return (await request(input, init)).json();
}
