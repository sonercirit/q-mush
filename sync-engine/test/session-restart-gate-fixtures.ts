export interface RestartCanceledDiscovery {
  readonly controller: AbortController;
  readonly discover: () => Promise<never>;
}

export function restartCanceledDiscovery(): RestartCanceledDiscovery {
  const controller = new AbortController();
  return {
    controller,
    discover: () => {
      const error = new DOMException(
        "The server is restarting",
        "RestartHandoff",
      );
      controller.abort(error);
      return Promise.reject(error);
    },
  };
}

export function restartReplacementDiscovery<Value>(value: Value) {
  let controller = new AbortController();
  return {
    discover: () => {
      controller.abort(new Error("restart"));
      controller = new AbortController();
      return Promise.resolve(value);
    },
    signal: () => controller.signal,
  };
}
