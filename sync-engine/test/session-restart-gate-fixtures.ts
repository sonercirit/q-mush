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
