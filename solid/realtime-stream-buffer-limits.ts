import { MAXIMUM_TOOL_STREAMS_PER_USER } from "../shared/tool-stream.ts";
import { USER_REALTIME_MAX_PAYLOAD_LENGTH } from "../shared/user-realtime-protocol.ts";

export const MAXIMUM_PENDING_STREAM_BYTES =
  USER_REALTIME_MAX_PAYLOAD_LENGTH - 1;
// The key and fragment budgets intentionally share the protocol stream ceiling.
export const MAXIMUM_PENDING_STREAM_KEYS = MAXIMUM_TOOL_STREAMS_PER_USER;
export const MAXIMUM_PENDING_STREAM_FRAGMENTS = MAXIMUM_TOOL_STREAMS_PER_USER;
