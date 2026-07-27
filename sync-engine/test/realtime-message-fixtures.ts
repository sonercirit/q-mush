import { isRecord } from "../../shared/auth-model.ts";

export function registrationCommittedMessage(registrationId: string): string {
  return JSON.stringify({ registrationId, type: "registration_committed" });
}

function registrationReceiptMessage(
  registrationId: string,
  activationReceipt: string,
  type: "registration_active" | "registration_finalized",
): string {
  return JSON.stringify({ activationReceipt, registrationId, type });
}

function defaultRegistrationReceipt(
  registrationId: string,
  type: "registration_active" | "registration_finalized",
  activationReceipt = "test-activation-receipt",
): string {
  return registrationReceiptMessage(registrationId, activationReceipt, type);
}

type RegistrationReceiptParameters = [
  registrationId: string,
  activationReceipt?: string,
];

export function registrationActiveMessage(
  ...[registrationId, activationReceipt]: RegistrationReceiptParameters
): string {
  return defaultRegistrationReceipt(
    registrationId,
    "registration_active",
    activationReceipt,
  );
}

export function registrationFinalizedMessage(
  ...[registrationId, activationReceipt]: RegistrationReceiptParameters
): string {
  return defaultRegistrationReceipt(
    registrationId,
    "registration_finalized",
    activationReceipt,
  );
}

export function registrationOperationalMessage(registrationId: string): string {
  return JSON.stringify({ registrationId, type: "registration_operational" });
}

export function runnerReadyMessage(
  registrationId: string,
  runnerId = "runner-1",
): string {
  return JSON.stringify({
    registrationId,
    runnerId,
    type: "registration_ready",
    version: "runner-version",
  });
}

export function runnerRestartReadyMessage(restartId: string): string {
  return JSON.stringify({ restartId, type: "restart_ready" });
}

export function parseRealtimeMessages(messages: readonly string[]): unknown[] {
  return messages.map((message): unknown => JSON.parse(message));
}

export async function waitForRealtimeTasks(): Promise<void> {
  await Promise.resolve();
}

export async function waitForRealtimeEvent(
  messages: readonly string[],
  eventType: string,
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (
      parseRealtimeMessages(messages).some(
        (message) => isRecord(message) && message["type"] === eventType,
      )
    ) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error(`The ${eventType} realtime event was not received`);
}
