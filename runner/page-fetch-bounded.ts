export function runBoundedPageOperation<Value>(
  operation: (signal: AbortSignal) => Promise<Value>,
  timeoutMilliseconds: number,
  signal: AbortSignal | undefined,
): Promise<Value> {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      signal?.removeEventListener("abort", stop);
      action();
    };
    const fail = (error: Error): void => {
      controller.abort(error);
      finish(() => {
        reject(error);
      });
    };
    const stop = (): void => {
      if (!settled) {
        fail(new Error("The page fetch was stopped"));
      }
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (signal?.aborted === true) {
      queueMicrotask(() => {
        stop();
      });
    } else {
      const abortOptions: AddEventListenerOptions = { once: true };
      signal?.addEventListener("abort", stop, abortOptions);
      timer = setTimeout(() => {
        if (!settled) {
          fail(new Error("The page fetch timed out"));
        }
      }, timeoutMilliseconds);
      void operation(controller.signal).then(
        (value) => {
          finish(() => {
            resolve(value);
          });
        },
        (error: unknown) => {
          finish(() => {
            reject(error instanceof Error ? error : new Error(String(error)));
          });
        },
      );
    }
  });
}
