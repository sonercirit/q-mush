const DEFAULT_DATABASE_PATH = "data/q-mush.sqlite";

export function readDatabasePath(
  environment: Readonly<Record<string, string | undefined>>,
): string {
  const configuredPath = environment["DATABASE_PATH"]?.trim();
  return configuredPath === undefined || configuredPath.length === 0
    ? DEFAULT_DATABASE_PATH
    : configuredPath;
}
