export interface RecoverableQuestionIdentity {
  readonly executionGeneration: number;
  readonly requestId: string;
  readonly sessionId: string;
  readonly userId: string;
}

export interface SessionLifecycleDependencies {
  readonly now: () => number;
  readonly notify: (userId: string, sessionId: string) => void;
}
