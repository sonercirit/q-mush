export const FINAL_SHUTDOWN_PREPARED_MESSAGE = "q-mush:final-shutdown-prepared";

// A restart drain waits for in-flight steps, and a step owns its tool calls,
// so a validation battery legitimately holds one for minutes. The development
// supervisor's restart path (`drainChild`) awaits the child's exit with no
// timeout at all — only its final stop is bounded by the preparation and grace
// windows before SIGKILL — so nothing outside the engine can end a stuck
// restart drain. Issue #152 asks for a generous bound of two to five minutes;
// two minutes is its lowest sanctioned value, so restarts converge as early as
// that guidance allows while still letting long tool calls finish. Passing it
// force-parks the stragglers durably instead of waiting forever, and final
// shutdown keeps its own supervisor-owned grace window and SIGKILL.
export const RESTART_DRAIN_LIMIT_MS = 120_000;
