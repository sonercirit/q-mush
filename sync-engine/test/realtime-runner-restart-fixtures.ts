import {
  connectedRunnerRealtimeTestIntegration,
  REALTIME_TEST_USER,
  realtimeRunnerConnection,
  type RealtimeSessionOverrides,
} from "./realtime-test-helpers.ts";

export interface RestartRealtimeFixture {
  readonly finalizedReceipts: Set<string>;
  readonly realtime: ReturnType<typeof connectedRunnerRealtimeTestIntegration>;
}

export function connectedRestartRealtime(
  sessionOverrides: RealtimeSessionOverrides,
): RestartRealtimeFixture {
  const finalizedReceipts = new Set<string>();
  return {
    finalizedReceipts,
    realtime: connectedRunnerRealtimeTestIntegration(
      sessionOverrides,
      {
        connect: () =>
          realtimeRunnerConnection("runner-1", REALTIME_TEST_USER.id),
      },
      finalizedReceipts,
    ),
  };
}

export function recordedRestartIds(): {
  readonly ids: string[];
  readonly record: (_runnerId: string, restartId: string) => boolean;
} {
  const ids: string[] = [];
  return {
    ids,
    record: (_runnerId, restartId) => {
      ids.push(restartId);
      return true;
    },
  };
}
