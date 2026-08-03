export const RUNNER_SUPERSEDED_CLOSE_CODE = 4_001;

export function runnerSupersededMessage(): string {
  return JSON.stringify({ type: "superseded" });
}

export function runnerRegistrationRejectedMessage(): string {
  return JSON.stringify({ type: "registration_rejected" });
}

export interface RunnerConnectMetadata {
  readonly architecture: string;
  readonly machineId: string;
  readonly name: string;
  readonly platform: string;
}

export interface RunnerConnectOptions {
  readonly activationReceipt?: string;
  readonly restartId?: string;
}

export interface RunnerActivationReceipt {
  readonly value: string;
}

export function encodeRunnerActivationReceipt(
  receipt: RunnerActivationReceipt,
): string {
  return receipt.value;
}

export function runnerRegistrationAcceptMessage(
  registrationId: string,
): string {
  return JSON.stringify({ registrationId, type: "registration_accept" });
}

export function runnerRegistrationReceivedMessage(
  registrationId: string,
): string {
  return JSON.stringify({ registrationId, type: "registration_received" });
}

export function runnerRegistrationActiveReceivedMessage(
  registrationId: string,
): string {
  return JSON.stringify({
    registrationId,
    type: "registration_active_received",
  });
}

export function runnerRegistrationFinalizedReceivedMessage(
  registrationId: string,
): string {
  return JSON.stringify({
    registrationId,
    type: "registration_finalized_received",
  });
}

export function runnerRegistrationOperationalReceivedMessage(
  registrationId: string,
): string {
  return JSON.stringify({
    registrationId,
    type: "registration_operational_received",
  });
}

function optionalObjectEntry<Key extends string>(
  key: Key,
  value: string | undefined,
): Partial<Record<Key, string>> {
  if (value === undefined) {
    return {};
  }
  const entry: Partial<Record<Key, string>> = {};
  entry[key] = value;
  return entry;
}

export function runnerConnectMessage(
  metadata: RunnerConnectMetadata,
  options: RunnerConnectOptions = {},
): string {
  return JSON.stringify({
    ...metadata,
    ...optionalObjectEntry("activationReceipt", options.activationReceipt),
    ...optionalObjectEntry("restartId", options.restartId),
    type: "connect",
  });
}
