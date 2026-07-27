import {
  readAgentSessionToolNames,
  type AgentSessionToolName,
} from "./agent-tools.ts";
import { isRecord } from "./auth-model.ts";
import { readBoundedString, readNonNegativeSafeInteger } from "./validation.ts";

export interface SessionToolUpdateInput {
  readonly confirmedCacheDrop: boolean;
  readonly expectedGeneration: number;
  readonly sessionId: string;
  readonly tools: readonly AgentSessionToolName[];
  readonly workspaceId: string;
}

type SessionToolSelection = Readonly<{
  sessionId: string;
  tools: readonly AgentSessionToolName[];
  workspaceId: string;
}>;

export type SessionToolUpdatePreviewInput = SessionToolSelection;

type SessionToolCacheDisposition = "preserved" | "warning_required";

export interface SessionToolUpdatePreview {
  readonly cacheDisposition: SessionToolCacheDisposition;
  readonly currentGeneration: number;
  readonly tools: readonly AgentSessionToolName[];
  readonly warning: string | null;
}

export const SESSION_TOOL_CACHE_WARNING =
  "This provider/model cannot assure cache continuity when tools change. Applying this update might drop the model/provider cache.";

function identifier(value: unknown): string | undefined {
  return readBoundedString(value, 200);
}

function updateBase(value: unknown): SessionToolSelection | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const sessionId = identifier(value["sessionId"]);
  const tools = readAgentSessionToolNames(value["tools"]);
  const workspaceId = identifier(value["workspaceId"]);
  return sessionId === undefined ||
    tools === undefined ||
    workspaceId === undefined
    ? undefined
    : { sessionId, tools, workspaceId };
}

export function readSessionToolUpdatePreviewInput(
  value: unknown,
): SessionToolUpdatePreviewInput | undefined {
  const base = updateBase(value);
  return base === undefined ||
    !isRecord(value) ||
    Object.keys(value).length !== 3
    ? undefined
    : base;
}

export function readSessionToolUpdateInput(
  value: unknown,
): SessionToolUpdateInput | undefined {
  const base = updateBase(value);
  if (base === undefined || !isRecord(value)) {
    return undefined;
  }
  const confirmedCacheDrop = value["confirmedCacheDrop"];
  const expectedGeneration = readNonNegativeSafeInteger(
    value["expectedGeneration"],
  );
  return typeof confirmedCacheDrop !== "boolean" ||
    expectedGeneration === undefined ||
    Object.keys(value).length !== 5
    ? undefined
    : { ...base, confirmedCacheDrop, expectedGeneration };
}

export function sessionToolsMatch(
  left: readonly AgentSessionToolName[],
  right: readonly AgentSessionToolName[],
): boolean {
  return (
    left.length === right.length &&
    left.every((name, index) => name === right[index])
  );
}
