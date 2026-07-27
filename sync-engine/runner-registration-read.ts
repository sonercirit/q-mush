import { and, eq } from "drizzle-orm";
import { runners } from "../shared/database/schema.ts";
import type {
  RunnerMetadata,
  RunnerRegistrationFence,
  StoredRunnerRegistration,
} from "./runner-registration-types.ts";

export function activeMachineRunnerCondition(metadata: RunnerMetadata) {
  return and(
    eq(runners.isDeleted, false),
    eq(runners.machineFingerprint, metadata.machineFingerprint),
  );
}

export function runnerMetadataMatches(
  registration:
    | Pick<
        StoredRunnerRegistration,
        "architecture" | "machineFingerprint" | "name" | "platform"
      >
    | RunnerRegistrationFence
    | undefined,
  metadata: RunnerMetadata,
): boolean {
  return (
    registration?.architecture === metadata.architecture &&
    registration.machineFingerprint === metadata.machineFingerprint &&
    registration.name === metadata.name &&
    registration.platform === metadata.platform
  );
}
