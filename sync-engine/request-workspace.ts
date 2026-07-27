export function requestWorkspaceId(request: Request): string | null {
  return new URL(request.url).searchParams.get("workspaceId");
}
