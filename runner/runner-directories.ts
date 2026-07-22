import { readdir, realpath, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  MAXIMUM_RUNNER_DIRECTORY_ENTRIES,
  MAXIMUM_RUNNER_PATH_LENGTH,
  type RunnerDirectoryEntry,
  type RunnerDirectoryListing,
} from "../shared/runner-directory-model.ts";
import { expandRunnerHome } from "./runner-path.ts";

function compareDirectoryNames(
  left: RunnerDirectoryEntry,
  right: RunnerDirectoryEntry,
): number {
  const normalizedLeft = left.name.toLowerCase();
  const normalizedRight = right.name.toLowerCase();

  if (normalizedLeft !== normalizedRight) {
    return normalizedLeft < normalizedRight ? -1 : 1;
  }

  return left.name < right.name ? -1 : left.name === right.name ? 0 : 1;
}

export async function listRunnerDirectories(
  requestedPath: string,
): Promise<RunnerDirectoryListing> {
  const path = await realpath(expandRunnerHome(requestedPath));
  const details = await stat(path);

  if (!details.isDirectory()) {
    throw new Error("The browsing location is not a directory");
  }

  if (path.length > MAXIMUM_RUNNER_PATH_LENGTH) {
    throw new Error("The browsing location path is too long");
  }

  const entries = await readdir(path, { withFileTypes: true });
  const directoryEntries = entries.filter((entry) => entry.isDirectory());
  const availableDirectories = directoryEntries
    .map((entry) => ({ name: entry.name, path: join(path, entry.name) }))
    .filter((entry) => entry.path.length <= MAXIMUM_RUNNER_PATH_LENGTH)
    .sort(compareDirectoryNames);
  const parent = dirname(path);

  return {
    directories: availableDirectories.slice(
      0,
      MAXIMUM_RUNNER_DIRECTORY_ENTRIES,
    ),
    parent: parent === path ? null : parent,
    path,
    truncated:
      availableDirectories.length > MAXIMUM_RUNNER_DIRECTORY_ENTRIES ||
      availableDirectories.length < directoryEntries.length,
  };
}
