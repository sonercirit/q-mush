import type { RunnerSummary } from "../shared/runner-model.ts";
import type { CustomSelectOption } from "./custom-select.tsx";
import {
  sessionCredentialValue,
  type SessionCredentialOption,
} from "./session-credential-option.ts";
export {
  selectedSessionCredentialOption,
  sessionCredentialValue as sessionCredentialOptionValue,
} from "./session-credential-option.ts";

export function selectedOptionValue(
  options: readonly CustomSelectOption[],
  requested: string,
  fallback: string,
): string {
  return options.some((option) => option.value === requested)
    ? requested
    : fallback;
}

export function defaultOnlineRunnerId(
  runners: readonly RunnerSummary[],
): string {
  return runners.find(({ isDefault }) => isDefault)?.id ?? runners[0]?.id ?? "";
}

export function defaultModelCredentialValue(
  credentials: readonly SessionCredentialOption[],
): string {
  const credential =
    credentials.find((option) => option.credential.isDefault) ?? credentials[0];
  return credential === undefined ? "" : sessionCredentialValue(credential);
}
