export function sessionHasStatus(
  session: Readonly<{ status: string }> | undefined,
  status: string,
): boolean {
  return session?.status === status;
}
