import {
  applyRunnerEnvelope,
  compactRunnerOperationStore,
  type RunnerOperationTestStore,
} from "./runner-operation-store-test-support.ts";

export const applyAndCompactRunnerOperation = (
  store: RunnerOperationTestStore,
): string => {
  const encoded = applyRunnerEnvelope(store);
  compactRunnerOperationStore(store, 1n);
  return encoded;
};
