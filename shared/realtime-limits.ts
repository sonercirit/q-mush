export const MAXIMUM_REALTIME_MESSAGE_BYTES = 128 * 1024 * 1024;

const MAXIMUM_JSON_ESCAPED_CODE_POINT_BYTES = 6;
const MAXIMUM_RUNNER_COMMAND_IDENTIFIER_CHARACTERS = 200;
const MAXIMUM_RUNNER_RESULT_ENVELOPE_BYTES = new TextEncoder().encode(
  JSON.stringify({
    commandId: "\0".repeat(MAXIMUM_RUNNER_COMMAND_IDENTIFIER_CHARACTERS),
    output: "",
    state: "timed-out",
    type: "result",
  }),
).byteLength;

/**
 * Largest result character count that still fits the runner WebSocket after
 * every code point and command-ID character takes its longest JSON escape.
 * One additional code point is reserved so the engine can detect overflow.
 */
export const MAXIMUM_RUNNER_RESULT_OUTPUT_CHARACTERS =
  Math.floor(
    (MAXIMUM_REALTIME_MESSAGE_BYTES - MAXIMUM_RUNNER_RESULT_ENVELOPE_BYTES) /
      MAXIMUM_JSON_ESCAPED_CODE_POINT_BYTES,
  ) - 1;
