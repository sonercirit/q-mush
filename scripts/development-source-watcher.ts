import { watch, type FSWatcher } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, extname, join, relative, sep } from "node:path";

const WATCHED_DIRECTORIES = ["runner", "shared", "solid", "sync-engine"];
const WATCHED_ROOT_FILES = new Set([
  ".env",
  ".env.local",
  "bun.lock",
  "package.json",
  "tsconfig.json",
  "vite.config.ts",
]);
const WATCHED_EXTENSIONS = new Set([
  ".cjs",
  ".cts",
  ".css",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".svg",
  ".ts",
  ".tsx",
]);
const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".idea",
  ".vscode",
  "coverage",
  "data",
  "dist",
  "fixtures",
  "node_modules",
  "out",
  "test",
]);
const TEMPORARY_FILE_PATTERNS = [
  /^\.#/u,
  /^#.*#$/u,
  /~$/u,
  /\.sw[opx]$/u,
  /\.tmp$/u,
];

export interface DevelopmentSourceWatcher {
  stop(): void;
}

interface DevelopmentSourceWatcherOptions {
  readonly debounceMilliseconds?: number;
  readonly onChange: () => Promise<void> | void;
  readonly projectRoot: string;
}

function projectPath(projectRoot: string, pathname: string): string {
  return relative(projectRoot, pathname).split(sep).join("/");
}

function temporaryFile(pathname: string): boolean {
  const name = basename(pathname);
  return TEMPORARY_FILE_PATTERNS.some((pattern) => pattern.test(name));
}

function ignoredDirectory(pathname: string): boolean {
  return pathname.split("/").some((part) => IGNORED_DIRECTORIES.has(part));
}

function isDevelopmentSourcePath(pathname: string): boolean {
  if (
    pathname.length === 0 ||
    ignoredDirectory(pathname) ||
    temporaryFile(pathname)
  ) {
    return false;
  }
  if (!pathname.includes("/")) {
    return (
      WATCHED_ROOT_FILES.has(pathname) ||
      WATCHED_EXTENSIONS.has(extname(pathname))
    );
  }
  const root = pathname.split("/", 1)[0];
  return (
    root !== undefined &&
    WATCHED_DIRECTORIES.includes(root) &&
    WATCHED_EXTENSIONS.has(extname(pathname))
  );
}

async function directoryPaths(root: string): Promise<readonly string[]> {
  const paths = [root];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || IGNORED_DIRECTORIES.has(entry.name)) {
      continue;
    }
    paths.push(...(await directoryPaths(join(root, entry.name))));
  }
  return paths;
}

export async function startDevelopmentSourceWatcher(
  options: DevelopmentSourceWatcherOptions,
): Promise<DevelopmentSourceWatcher> {
  const watchers = new Map<string, FSWatcher>();
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const schedule = (): void => {
    if (debounceTimer !== undefined) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      void options.onChange();
    }, options.debounceMilliseconds ?? 350);
  };

  const addWatcher = (directory: string): void => {
    if (watchers.has(directory) || stopped) {
      return;
    }
    try {
      const watcher = watch(directory, (_event, filename) => {
        if (filename === null) {
          return;
        }
        const pathname = join(directory, filename);
        if (
          isDevelopmentSourcePath(projectPath(options.projectRoot, pathname))
        ) {
          schedule();
        }
        void refreshWatchers();
      });
      watcher.on("error", () => {
        watcher.close();
        watchers.delete(directory);
      });
      watchers.set(directory, watcher);
    } catch {
      // A concurrently removed directory is discovered by a later event.
    }
  };

  const refreshWatchers = async (): Promise<void> => {
    for (const watchedRoot of WATCHED_DIRECTORIES) {
      try {
        for (const directory of await directoryPaths(
          join(options.projectRoot, watchedRoot),
        )) {
          addWatcher(directory);
        }
      } catch {
        // A concurrently removed source tree is rediscovered if recreated.
      }
    }
  };

  addWatcher(options.projectRoot);
  await refreshWatchers();

  return {
    stop: () => {
      stopped = true;
      if (debounceTimer !== undefined) {
        clearTimeout(debounceTimer);
        debounceTimer = undefined;
      }
      for (const watcher of watchers.values()) {
        watcher.close();
      }
      watchers.clear();
    },
  };
}
