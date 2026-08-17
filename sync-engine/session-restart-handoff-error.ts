export function isRestartHandoffError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "RestartHandoff";
}
