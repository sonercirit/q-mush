export function optionalRestartHandoff(
  clearRestartHandoff: boolean | undefined,
): { readonly restartHandoff?: null } {
  return clearRestartHandoff === true ? { restartHandoff: null } : {};
}
