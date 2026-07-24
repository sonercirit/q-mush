import { expect, test } from "vitest";
import { SERVICE_WORKER_PATH } from "../../shared/routes.ts";
import {
  isServiceWorkerRegistrationLike,
  registerQmushServiceWorker,
} from "../pwa-client.ts";

class Registration extends EventTarget {}

const noop = (): void => undefined;

function immediateOptions(register: () => Promise<Registration>) {
  return {
    addWindowListener: () => noop,
    enabled: true,
    loaded: true,
    register,
  };
}

async function expectSuppressed(
  result: ReturnType<typeof registerQmushServiceWorker>,
): Promise<void> {
  await expect(result.registration).resolves.toBeUndefined();
}

test("validates registrations before attaching lifecycle listeners", () => {
  const invalidValues = [undefined, {}, { addEventListener: noop }];
  expect(
    invalidValues.every((value) => !isServiceWorkerRegistrationLike(value)),
  ).toBe(true);
  expect(isServiceWorkerRegistrationLike(new Registration())).toBe(true);
});

test("registers the same-origin worker after the production page loads", async () => {
  const events: string[] = [];
  const expected = new Registration();
  let load: (() => void) | undefined;
  const result = registerQmushServiceWorker({
    addWindowListener: (type, listener) => {
      expect(type).toBe("load");
      events.push("listen");
      load = listener;
      return () => {
        events.push("unlisten");
      };
    },
    enabled: true,
    loaded: false,
    register: (path, options) => {
      events.push("register");
      expect(path).toBe(SERVICE_WORKER_PATH);
      expect(options).toEqual({ scope: "/", updateViaCache: "none" });
      return Promise.resolve(expected);
    },
  });

  expect(events).toEqual(["listen"]);
  load?.();
  await expect(result.registration).resolves.toBe(expected);
  expect(events).toEqual(["listen", "register"]);
});

test("contains synchronous registration failures after load", async () => {
  let calls = 0;
  const result = registerQmushServiceWorker(
    immediateOptions(() => {
      calls += 1;
      throw new Error("unsupported");
    }),
  );

  expect(calls).toBe(1);
  await expectSuppressed(result);
});

test("suppresses a registration that resolves after disposal", async () => {
  let resolveRegistration: ((registration: Registration) => void) | undefined;
  const result = registerQmushServiceWorker(
    immediateOptions(
      () =>
        new Promise<Registration>((resolve) => {
          resolveRegistration = resolve;
        }),
    ),
  );

  result.cancel();
  resolveRegistration?.(new Registration());
  await expectSuppressed(result);
});

test("cancels a pending load listener on disposal", async () => {
  let load: (() => void) | undefined;
  const actions: string[] = [];
  const result = registerQmushServiceWorker({
    addWindowListener: (_, listener) => {
      load = listener;
      return () => {
        actions.push("remove");
      };
    },
    enabled: true,
    loaded: false,
    register: () => {
      actions.push("register");
      return Promise.resolve(new Registration());
    },
  });

  result.cancel();
  load?.();

  expect(actions).toEqual(["remove"]);
  await expectSuppressed(result);
});

test("does not touch service workers outside production", async () => {
  let touched = false;
  const touch = (): Promise<Registration> => {
    touched = true;
    return Promise.reject(new Error("must not register"));
  };
  const result = registerQmushServiceWorker({
    ...immediateOptions(touch),
    addWindowListener: () => {
      touched = true;
      return noop;
    },
    enabled: false,
  });

  expect(touched).toBe(false);
  await expectSuppressed(result);
});
