export function parseRunnerUrl(value: string, invalidMessage: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new Error(invalidMessage);
  }
}
