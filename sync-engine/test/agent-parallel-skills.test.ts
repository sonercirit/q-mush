import { expectCompleteParallelPayload } from "../../shared/test/parallel-fixtures.ts";
import { registerParallelSkillExecutionTests } from "./agent-parallel-skill-test-suite.ts";
registerParallelSkillExecutionTests((output) => {
  const largePayload = "x".repeat(60 * 1_024);
  expectCompleteParallelPayload(output, largePayload);
});
