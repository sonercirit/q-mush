import { RunnerCommandBroker } from "../../shared/runner-command-broker.ts";
import { sessionAgentActionRuntimeDefaults } from "./session-agent-action-runtime-fixtures.ts";

export const EMPTY_SESSION_REQUEST_MODEL_METADATA = {
  adaptiveThinking: null,
  maxContextTokens: null,
  maxOutputTokens: null,
  providerPricing: null,
} as const;

export function sessionAgentActionDefaults() {
  const runtimeDefaults = sessionAgentActionRuntimeDefaults();
  return {
    broker: new RunnerCommandBroker(),
    cleanupSession: () => undefined,
    discoverModels: () => Promise.resolve({ defaultModel: null, models: [] }),
    ...runtimeDefaults,
  };
}

export interface PromiseGate<Value = undefined> {
  readonly entered: Promise<void>;
  readonly promise: Promise<Value>;
  readonly release: (value: Value) => void;
  readonly wait: () => Promise<Value>;
}

export function promiseGate<Value = undefined>(): PromiseGate<Value> {
  const { promise, resolve } = Promise.withResolvers<Value>();
  const entrance = Promise.withResolvers<undefined>();
  return {
    entered: entrance.promise,
    promise,
    release: resolve,
    wait: () => {
      entrance.resolve(undefined);
      return promise;
    },
  };
}
