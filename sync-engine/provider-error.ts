import { isRecord } from "../shared/auth-model.ts";
import { withoutControlCharacters } from "../shared/string-validation.ts";

const ERROR_DETAIL_MAXIMUM_LENGTH = 500;
const RETRY_AFTER_MAX_MILLISECONDS = 60_000;
const SECRET_PATTERN = /\b(?:sk|sess|Bearer)[-_A-Za-z0-9.]{8,}\b/giu;
const WEBSOCKET_RECONNECT_ERROR_CODES = new Set([
  "websocket_connection_limit_reached",
  "websocketconnectionlimit_reached",
]);
const TRANSIENT_ERROR_CODES = new Set([
  "api_connection_error",
  "conflict",
  "engine_overloaded",
  "gateway_timeout",
  "internal_error",
  "internal_server_error",
  "overloaded",
  "provider_unavailable",
  "rate_limit_error",
  "rate_limit_exceeded",
  "request_timeout",
  "server_error",
  "server_is_overloaded",
  "service_unavailable",
  "slow_down",
  "temporarily_unavailable",
  "timeout",
  "upstream_error",
]);
const OPENAI_AUTHENTICATION_ERROR_CODES = new Set([
  "authentication_error",
  "invalid_api_key",
]);
const PERMANENT_ERROR_CODES = new Set([
  "authentication_error",
  "bad_request",
  "bio_policy",
  "context_length_exceeded",
  "cyber_policy",
  "insufficient_quota",
  "invalid_api_key",
  "invalid_prompt",
  "invalid_request",
  "invalid_request_error",
  "moderation_blocked",
  "model_not_found",
  "not_found_error",
  "permission_error",
  "permission_denied",
  "policy_violation",
  "usage_not_included",
  "unsupported_parameter",
]);

type ProviderErrorCode = number | string;

interface ProviderErrorDetails {
  readonly codes: readonly ProviderErrorCode[];
  readonly detail: string;
  readonly retryAfterMilliseconds: number | undefined;
  readonly status: number | undefined;
}

export class ProviderCredentialRejectionError extends Error {
  readonly status: 400 | 401 | 402 | 403 | 429;

  constructor(message: string, status: 400 | 401 | 402 | 403 | 429) {
    super(message);
    this.name = "ProviderCredentialRejectionError";
    this.status = status;
  }
}

export class ProviderCredentialReauthenticationRequiredError extends ProviderCredentialRejectionError {
  constructor(providerName: string, status: 400 | 401 | 403 = 401) {
    super(
      `${providerName} login has expired. Connect the account again to continue.`,
      status,
    );
    this.name = "ProviderCredentialReauthenticationRequiredError";
  }
}

export function isProviderCredentialRejection(
  error: unknown,
): error is ProviderCredentialRejectionError {
  return error instanceof ProviderCredentialRejectionError;
}

export class ProviderStreamError extends Error {
  readonly authenticationFailure: boolean;
  readonly reconnectWebSocket: boolean;
  readonly retryAfterMilliseconds: number | undefined;
  readonly status: number | undefined;
  readonly transient: boolean;

  constructor(
    message: string,
    transient: boolean,
    options: ProviderStreamErrorOptions = {},
  ) {
    super(message);
    this.authenticationFailure = options.authenticationFailure === true;
    this.name = "ProviderStreamError";
    this.reconnectWebSocket = options.reconnectWebSocket === true;
    this.retryAfterMilliseconds = options.retryAfterMilliseconds;
    this.status = options.status;
    this.transient = transient;
  }
}

interface ProviderStreamErrorOptions {
  readonly authenticationFailure?: boolean;
  readonly reconnectWebSocket?: boolean;
  readonly retryAfterMilliseconds?: number | undefined;
  readonly status?: number | undefined;
}

function requiredTrimmedString(value: unknown): string | undefined {
  const string = typeof value === "string" ? value.trim() : "";
  return string || undefined;
}

interface ProviderErrorSources {
  readonly error: Readonly<Record<string, unknown>>;
  readonly response: Readonly<Record<string, unknown>> | undefined;
}

function providerErrorSources(
  event: Readonly<Record<string, unknown>>,
): ProviderErrorSources {
  const responseValue = event["response"];
  const response = isRecord(responseValue) ? responseValue : undefined;
  const candidates: unknown[] = [event["error"], response?.["error"], event];
  return { error: candidates.find(isRecord) ?? event, response };
}

function retryAfterMilliseconds(
  error: Readonly<Record<string, unknown>>,
): number | undefined {
  for (const [key, multiplier] of [
    ["retry_after_ms", 1],
    ["retry_after_milliseconds", 1],
    ["retry_after", 1_000],
  ] as const) {
    const value = error[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return value * multiplier;
    }
  }
  return undefined;
}

function providerErrorContext(
  event: Readonly<Record<string, unknown>>,
  response: Readonly<Record<string, unknown>> | undefined,
  error: Readonly<Record<string, unknown>>,
): string {
  const message = requiredTrimmedString(error["message"] ?? event["message"]);
  const requestId = requiredTrimmedString(
    event["request_id"] ??
      event["requestId"] ??
      event["id"] ??
      event["event_id"] ??
      response?.["request_id"] ??
      response?.["requestId"] ??
      response?.["id"],
  );
  const request = requestId === undefined ? "" : `request ID ${requestId}`;
  return [request, message ?? ""]
    .filter((value) => value.length > 0)
    .join(": ");
}

function providerMetadataErrorType(
  error: Readonly<Record<string, unknown>>,
): string | undefined {
  const metadata = error["metadata"];
  return isRecord(metadata)
    ? requiredTrimmedString(metadata["error_type"])
    : undefined;
}

function numericCode(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return value;
  }
  if (typeof value !== "string" || !/^\d+$/u.test(value.trim())) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function providerErrorCodes(
  error: Readonly<Record<string, unknown>>,
): readonly ProviderErrorCode[] {
  return [error["code"], error["type"], providerMetadataErrorType(error)]
    .map(
      (value): ProviderErrorCode | undefined =>
        numericCode(value) ?? requiredTrimmedString(value),
    )
    .filter((value): value is number | string => value !== undefined);
}

function providerErrorDetails(
  event: Readonly<Record<string, unknown>>,
): ProviderErrorDetails {
  const { error, response } = providerErrorSources(event);
  const codes = providerErrorCodes(error);
  const retryAfter = retryAfterMilliseconds(error);
  const statusValue = event["status"] ?? error["status"];
  return {
    codes,
    detail: providerErrorContext(event, response, error),
    retryAfterMilliseconds:
      retryAfter === undefined
        ? undefined
        : Math.min(retryAfter, RETRY_AFTER_MAX_MILLISECONDS),
    status: numericCode(statusValue),
  };
}

function codeIsAuthenticationFailure(code: ProviderErrorCode): boolean {
  return (
    typeof code === "string" &&
    OPENAI_AUTHENTICATION_ERROR_CODES.has(code.toLowerCase())
  );
}

function codeIsWebSocketConnectionLimit(code: ProviderErrorCode): boolean {
  if (typeof code === "number") {
    return false;
  }
  return WEBSOCKET_RECONNECT_ERROR_CODES.has(code.toLowerCase());
}

function codeIsTransient(code: ProviderErrorCode): boolean {
  if (typeof code === "number") {
    return code === 408 || code === 409 || code === 429 || code >= 500;
  }
  return TRANSIENT_ERROR_CODES.has(code.toLowerCase());
}

function codeIsPermanent(code: ProviderErrorCode): boolean {
  if (typeof code === "number") {
    return code >= 400 && code < 500 && !codeIsTransient(code);
  }
  return PERMANENT_ERROR_CODES.has(code.toLowerCase());
}

function sanitize(value: string): string {
  return withoutControlCharacters(value)
    .replaceAll(SECRET_PATTERN, "[redacted]")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, ERROR_DETAIL_MAXIMUM_LENGTH);
}

function providerErrorMessage(details: ProviderErrorDetails): string {
  const code = details.codes[0];
  const label = code === undefined ? "" : ` (code ${String(code)})`;
  const detail = details.detail.length === 0 ? "" : `: ${details.detail}`;
  return sanitize(
    `The provider failed to complete the request${label}${detail}`,
  );
}

export function readProviderStreamError(
  event: Readonly<Record<string, unknown>>,
): ProviderStreamError {
  const details = providerErrorDetails(event);
  const transient =
    details.codes.some(codeIsTransient) ||
    (details.status !== undefined && codeIsTransient(details.status));
  const permanent =
    details.codes.some(codeIsPermanent) ||
    (details.status !== undefined && codeIsPermanent(details.status));
  return new ProviderStreamError(
    providerErrorMessage(details),
    !permanent && (transient || isProviderStreamErrorEvent(event)),
    {
      authenticationFailure: details.codes.some(codeIsAuthenticationFailure),
      reconnectWebSocket: details.codes.some(codeIsWebSocketConnectionLimit),
      retryAfterMilliseconds: details.retryAfterMilliseconds,
      status: details.status,
    },
  );
}

export function isProviderStreamErrorEvent(
  event: Readonly<Record<string, unknown>>,
): boolean {
  if (event["type"] === "response.failed" || event["type"] === "error") {
    return true;
  }
  return isRecord(event["error"]);
}
