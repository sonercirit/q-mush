import { isRecord } from "./auth-model.ts";
import { isValidBoundedString } from "./string-validation.ts";

export const RUNNER_DIRECTORY_COMMAND = "list_directories";
export const MAXIMUM_RUNNER_DIRECTORY_ENTRIES = 500;
export const MAXIMUM_RUNNER_PATH_LENGTH = 4_096;
const MAXIMUM_DIRECTORY_NAME_LENGTH = 1_024;

export interface RunnerDirectoryEntry {
  readonly name: string;
  readonly path: string;
}

export interface RunnerDirectoryListing {
  readonly directories: readonly RunnerDirectoryEntry[];
  readonly parent: string | null;
  readonly path: string;
  readonly truncated: boolean;
}

function validString(value: unknown, maximumLength: number): value is string {
  return isValidBoundedString(value, maximumLength);
}

function readDirectoryEntry(value: unknown): RunnerDirectoryEntry {
  if (
    !isRecord(value) ||
    !validString(value["name"], MAXIMUM_DIRECTORY_NAME_LENGTH) ||
    !validString(value["path"], MAXIMUM_RUNNER_PATH_LENGTH)
  ) {
    throw new Error("The runner returned an invalid directory listing");
  }

  return { name: value["name"], path: value["path"] };
}

export function readRunnerDirectoryListing(
  value: unknown,
): RunnerDirectoryListing {
  if (
    !isRecord(value) ||
    !Array.isArray(value["directories"]) ||
    value["directories"].length > MAXIMUM_RUNNER_DIRECTORY_ENTRIES ||
    !validString(value["path"], MAXIMUM_RUNNER_PATH_LENGTH) ||
    (value["parent"] !== null &&
      !validString(value["parent"], MAXIMUM_RUNNER_PATH_LENGTH)) ||
    typeof value["truncated"] !== "boolean"
  ) {
    throw new Error("The runner returned an invalid directory listing");
  }

  return {
    directories: value["directories"].map(readDirectoryEntry),
    parent: value["parent"],
    path: value["path"],
    truncated: value["truncated"],
  };
}
