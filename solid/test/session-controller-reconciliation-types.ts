import type {
  SESSION_REALTIME_OPERATIONS,
  UserRealtimeCommand,
} from "../../shared/user-realtime-protocol.ts";

export type OperationName = keyof typeof SESSION_REALTIME_OPERATIONS;
export type Operation = UserRealtimeCommand["operation"];
export type Payload = UserRealtimeCommand["payload"];
export type PendingFlag = "compacting" | "creating" | "sending" | "stopping";
export type ReconciliationTest = () => Promise<void>;
export type StateMatch = Readonly<Record<string, unknown>>;

export type SessionMutationName =
  "compact" | "continueSession" | "send" | "stop";
export type ControllerMutationName = SessionMutationName | "create";
