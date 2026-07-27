import { createHmac, timingSafeEqual } from "node:crypto";
import type { RunnerRegistrationFence } from "./runner-registration-types.ts";

function receiptPayload(fence: RunnerRegistrationFence): string {
  return [
    fence.activationId,
    String(fence.generation),
    fence.lifecycle,
    fence.restartId ?? "",
    fence.sourceId,
    fence.targetId,
    String(fence.targetGeneration),
    fence.userId,
    fence.tokenDigest,
    fence.machineFingerprint,
    fence.architecture,
    fence.name,
    fence.platform,
  ].join("\u0000");
}

export function activationReceipt(fence: RunnerRegistrationFence): string {
  return createHmac("sha256", fence.tokenHash)
    .update(receiptPayload(fence))
    .digest("base64url");
}

export function receiptMatches(
  fence: RunnerRegistrationFence,
  receipt: string,
): boolean {
  const actual = Buffer.from(receipt);
  const expected = Buffer.from(activationReceipt(fence));
  return (
    actual.byteLength === expected.byteLength &&
    timingSafeEqual(actual, expected)
  );
}
