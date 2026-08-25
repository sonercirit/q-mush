import { requestJson } from "./browser-http.ts";

export interface ActiveView {
  readonly complete: boolean;
  readonly origin: "engine" | "runner";
  readonly partial: true;
  readonly records: readonly Record<string, unknown>[];
}

export interface QueryHost {
  readonly mutations: boolean;
  readonly origin: "engine" | "runner";
  readonly read: (
    entity: "agent_messages" | "agent_sessions",
    options: { readonly limit: number; readonly sessionId?: string },
  ) => Promise<ActiveView>;
}

function boundedLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("Active view limit must be between 1 and 100");
  }
  return limit;
}

export function createQueryHost(origin: "engine" | "runner"): QueryHost {
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
          : `/api/views/active?${parameters.toString()}`;
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

export function queryHostForLocation(
  location: Pick<Location, "hostname">,
): QueryHost {
  return createQueryHost(
    location.hostname === "127.0.0.1" || location.hostname === "[::1]"
      ? "runner"
      : "engine",
  );
}
