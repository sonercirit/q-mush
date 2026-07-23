import { describe, expect, test } from "vitest";
import { SERVICE_WORKER_PATH } from "../../shared/routes.ts";
import {
  canOfferPwaInstall,
  isIosDevice,
  isServiceWorkerRegistrationLike,
  isStandalonePwa,
  registerQmushServiceWorker,
} from "../pwa-client.ts";

describe("PWA environment detection", () => {
  test("detects standalone and iOS installation states", () => {
    expect(isStandalonePwa({ matches: true }, false)).toBe(true);
    expect(isStandalonePwa({ matches: false }, true)).toBe(true);
    expect(isStandalonePwa({ matches: false }, false)).toBe(false);
    expect(isIosDevice("Mozilla/5.0 (iPhone)", 0)).toBe(true);
    expect(isIosDevice("Mozilla/5.0 (Macintosh)", 5)).toBe(true);
    expect(isIosDevice("Mozilla/5.0 (X11; Linux x86_64)", 0)).toBe(false);
  });

  test("offers installation only when actionable or useful", () => {
    expect(canOfferPwaInstall(false, false, false)).toBe(false);
    expect(canOfferPwaInstall(false, true, false)).toBe(true);
    expect(canOfferPwaInstall(false, false, true)).toBe(true);
    expect(canOfferPwaInstall(true, true, true)).toBe(false);
  });
});

test("validates registrations before attaching lifecycle listeners", () => {
  expect(isServiceWorkerRegistrationLike(undefined)).toBe(false);
  expect(isServiceWorkerRegistrationLike({})).toBe(false);
  expect(
    isServiceWorkerRegistrationLike({ addEventListener: () => undefined }),
  ).toBe(true);
});
test("registers the same-origin worker only after a production load", async () => {
  const events: string[] = [];
  const registration = { addEventListener: () => undefined };
  const result = registerQmushServiceWorker({
    addWindowListener: (type, listener) => {
      expect(type).toBe("load");
      events.push("listen");
      listener();
    },
    enabled: true,
    register: (path, options) => {
      events.push("register");
      expect(path).toBe(SERVICE_WORKER_PATH);
      expect(options).toEqual({ scope: "/", updateViaCache: "none" });
      return Promise.resolve(registration);
    },
  });

  expect(events).toEqual(["listen", "register"]);
  await expect(result.registration).resolves.toBe(registration);
});

test("does not register or mutate service workers outside production", async () => {
  let touched = false;
  const result = registerQmushServiceWorker({
    addWindowListener: () => {
      touched = true;
    },
    enabled: false,
    register: () => {
      touched = true;
      return Promise.reject(new Error("must not register"));
    },
  });

  expect(touched).toBe(false);
  await expect(result.registration).resolves.toBeUndefined();
});
