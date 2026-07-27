import { describe, expect, test } from "vitest";
import {
  readSessionToolUpdateInput,
  readSessionToolUpdatePreviewInput,
  sessionToolsMatch,
} from "../session-tool-update.ts";

const UPDATE_SCOPE = {
  sessionId: "session-1",
  workspaceId: "workspace-1",
};

describe("session tool updates", () => {
  test("reads canonical preview and apply inputs from the live tool catalog", () => {
    expect(
      readSessionToolUpdatePreviewInput({
        ...UPDATE_SCOPE,
        tools: ["read", "parallel"],
      }),
    ).toEqual({
      sessionId: "session-1",
      tools: ["read", "parallel"],
      workspaceId: "workspace-1",
    });
    expect(
      readSessionToolUpdateInput({
        confirmedCacheDrop: false,
        expectedGeneration: 4,
        ...UPDATE_SCOPE,
        tools: ["read"],
      }),
    ).toMatchObject({ expectedGeneration: 4, tools: ["read"] });
  });

  test("rejects duplicates, unknown tools, stale shapes, and compares order", () => {
    expect(
      readSessionToolUpdatePreviewInput({
        ...UPDATE_SCOPE,
        tools: ["read", "read"],
      }),
    ).toBeUndefined();
    expect(
      readSessionToolUpdateInput({
        confirmedCacheDrop: true,
        expectedGeneration: -1,
        ...UPDATE_SCOPE,
        tools: ["unknown"],
      }),
    ).toBeUndefined();
    expect(sessionToolsMatch(["read", "bash"], ["read", "bash"])).toBe(true);
    expect(sessionToolsMatch(["read", "bash"], ["bash", "read"])).toBe(false);
  });
});
