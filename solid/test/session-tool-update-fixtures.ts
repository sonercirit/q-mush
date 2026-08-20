import type { ToolSettings } from "../../shared/tool-limits.ts";
import type { SessionToolUpdateEditor } from "../session-tool-update-client.tsx";
import { TEST_SESSION_DETAIL } from "./session-fixtures.ts";

export function testToolUpdateEditorProps(
  settings?: ToolSettings,
): Parameters<typeof SessionToolUpdateEditor>[0] {
  return {
    detail: TEST_SESSION_DETAIL,
    disabled: false,
    onApply: () => Promise.resolve({ updated: true, warning: null }),
    ...(settings === undefined ? {} : { settings }),
  };
}
