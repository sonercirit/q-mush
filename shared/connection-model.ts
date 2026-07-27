export interface ScopedConnectionSummary {
  readonly id: string;
  readonly isDefault: boolean;
  readonly isGlobal?: boolean;
  readonly workspaceIds?: readonly string[];
}

export interface PendingViewState {
  readonly creating: boolean;
  readonly error: string | undefined;
  readonly removingId: string | undefined;
  readonly settingDefaultId: string | undefined;
}
