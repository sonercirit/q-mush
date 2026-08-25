import {
  validActiveViewLimit,
  type ActiveView,
} from "../shared/active-view.ts";
import { requestJson } from "./browser-http.ts";

export interface QueryHost {
  readonly mutations: false;
  readonly origin: "engine" | "runner";
  readonly read: (
    entity: "agent_messages" | "agent_sessions",
    options: { readonly limit: number; readonly sessionId?: string },
  ) => Promise<ActiveView>;
}

export function isRunnerDocument(document: {
  readonly querySelector: (selectors: string) => unknown;
}): boolean {
  return document.querySelector('meta[name="q-mush-host"]') !== null;
}

export function queryHostForDocument(document: {
  readonly querySelector: (selectors: string) => unknown;
}): QueryHost {
  const origin =
    document.querySelector('meta[name="q-mush-host"][content="runner"]') ===
    null
      ? "engine"
      : "runner";
  return {
    mutations: false,
    origin,
    read: async (entity, options) => {
      if (!validActiveViewLimit(options.limit))
        throw new Error("Active view limit must be between 1 and 100");
      const parameters = new URLSearchParams({
        entity,
        limit: String(options.limit),
      });
      if (options.sessionId !== undefined)
        parameters.set("sessionId", options.sessionId);
      const value: unknown = await requestJson(
        `/api/local/view?${parameters.toString()}`,
      );
      if (
        typeof value !== "object" ||
        value === null ||
        !("records" in value) ||
        !Array.isArray(value.records) ||
        !("complete" in value) ||
        typeof value.complete !== "boolean"
      )
        throw new Error("The host returned an invalid active view");
      return {
        complete: value.complete,
        origin,
        partial: true,
        records: value.records.filter(
          (record): record is Record<string, unknown> =>
            typeof record === "object" && record !== null,
        ),
      };
    },
  };
}
