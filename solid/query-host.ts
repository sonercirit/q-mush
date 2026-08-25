import {
  validActiveViewLimit,
  type ActiveView,
} from "../shared/active-view.ts";
import { ACTIVE_VIEWS_PATH } from "../shared/routes.ts";
import { requestJson } from "./browser-http.ts";

export interface QueryHost {
  readonly mutations: boolean;
  readonly origin: "engine" | "runner";
  readonly read: (
    entity: "agent_messages" | "agent_sessions",
    options: { readonly limit: number; readonly sessionId?: string },
  ) => Promise<ActiveView>;
}

function boundedLimit(limit: number): number {
  if (!validActiveViewLimit(limit)) {
    throw new Error("Active view limit must be between 1 and 100");
  }
  return limit;
}

function createQueryHost(origin: "engine" | "runner"): QueryHost {
  return {
    mutations: origin === "engine",
    origin,
    read: async (entity, options) => {
      const parameters = new URLSearchParams({
        entity,
        limit: String(boundedLimit(options.limit)),
      });
      if (options.sessionId !== undefined)
        parameters.set("sessionId", options.sessionId);
      const path =
        origin === "runner"
          ? `/api/local/view?${parameters.toString()}`
          : `${ACTIVE_VIEWS_PATH}?${parameters.toString()}`;
      const value: unknown = await requestJson(path);
      if (
        typeof value !== "object" ||
        value === null ||
        !("records" in value) ||
        !Array.isArray(value.records) ||
        !("complete" in value) ||
        typeof value.complete !== "boolean"
      ) {
        throw new Error("The host returned an invalid active view");
      }
      const records = value.records.filter(
        (record): record is Record<string, unknown> =>
          typeof record === "object" && record !== null,
      );
      return {
        complete: value.complete,
        origin,
        partial: true,
        records,
      };
    },
  };
}

export function queryHostForDocument(
  document: Pick<Document, "querySelector">,
): QueryHost {
  return createQueryHost(
    document.querySelector('meta[name="q-mush-host"][content="runner"]') ===
      null
      ? "engine"
      : "runner",
  );
}
