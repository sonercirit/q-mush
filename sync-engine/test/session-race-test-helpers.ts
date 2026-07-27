import { RunnerCommandBroker } from "../../shared/runner-command-broker.ts";

export function sessionAgentActionDefaults() {
  return {
    broker: new RunnerCommandBroker(),
    cleanupSession: () => undefined,
    discoverModels: () => Promise.resolve({ defaultModel: null, models: [] }),
    draining: () => false,
    listRunnerOptions: () => ({ items: [], totalItems: 0 }),
    pendingRestart: () => undefined,
    runnerIsAvailable: () => true,
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
