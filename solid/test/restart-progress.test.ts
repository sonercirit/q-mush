import { describe, expect, test } from "vitest";
import {
  DEVELOPMENT_RESTART_PROGRESS_MESSAGE,
  type DevelopmentRestartProgressMessage,
} from "../../shared/development-shutdown.ts";
import { readRealtimeServerEvent } from "../realtime-client-codec.ts";
import { restartProgressNotice } from "../restart-progress.ts";

const progress: DevelopmentRestartProgressMessage = {
  progress: [
    {
      elapsedMs: 12_500,
      runnerId: "runner-1",
      sessionId: "session-1",
      tools: ["sleep", "brave_search"],
    },
  ],
  type: DEVELOPMENT_RESTART_PROGRESS_MESSAGE,
};

describe("development restart progress", () => {
  test("decodes bounded progress and renders active in-process tools", () => {
    const decoded = readRealtimeServerEvent(JSON.stringify(progress));
    expect(decoded).toEqual({
      progress: progress.progress,
      type: "development_restart_progress",
    });
    if (decoded.type !== "development_restart_progress") {
      throw new Error("The restart progress event was not decoded");
    }
    expect(restartProgressNotice(decoded.progress)).toContain(
      "session-1: sleep, brave_search (13s)",
    );
  });

  test("rejects malformed progress and reports final convergence", () => {
    expect(() =>
      readRealtimeServerEvent(
        JSON.stringify({
          progress: [{ ...progress.progress[0], tools: [1] }],
          type: DEVELOPMENT_RESTART_PROGRESS_MESSAGE,
        }),
      ),
    ).toThrow("invalid");
    expect(restartProgressNotice([])).toContain("no sessions");
    expect(restartProgressNotice(undefined)).toBeUndefined();
  });
});
