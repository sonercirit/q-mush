import { SERVICE_WORKER_PATH } from "../shared/routes.ts";

interface DisplayModeQuery {
  readonly matches: boolean;
}

export interface BeforeInstallPromptEvent extends Event {
  readonly userChoice: Promise<{ readonly outcome: "accepted" | "dismissed" }>;
  prompt(): Promise<void>;
}

interface ServiceWorkerRegistrationLike {
  addEventListener(type: "updatefound", listener: () => void): void;
  readonly installing?: ServiceWorkerLike | null;
  readonly waiting?: ServiceWorkerLike | null;
}

export function isServiceWorkerRegistrationLike(
  value: unknown,
): value is ServiceWorkerRegistrationLike {
  return (
    typeof value === "object" &&
    value !== null &&
    "addEventListener" in value &&
    typeof value.addEventListener === "function"
  );
}

interface ServiceWorkerLike extends EventTarget {
  readonly state: string;
}

export interface ServiceWorkerRegistrationResult {
  readonly registration: Promise<ServiceWorkerRegistrationLike | undefined>;
}

interface RegistrationOptions {
  readonly addWindowListener: (type: "load", listener: () => void) => void;
  readonly enabled: boolean;
  readonly register: (
    path: string,
    options: { readonly scope: string; readonly updateViaCache: "none" },
  ) => Promise<ServiceWorkerRegistrationLike>;
}

export function createPwaViewState(): PwaViewState {
  return {
    installPrompt: undefined,
    installed: false,
    iosInstallAvailable: false,
    offline: false,
    updateAvailable: false,
  };
}

export interface PwaViewState {
  readonly installPrompt: BeforeInstallPromptEvent | undefined;
  readonly installed: boolean;
  readonly iosInstallAvailable: boolean;
  readonly offline: boolean;
  readonly updateAvailable: boolean;
}

export function isStandalonePwa(
  displayMode: DisplayModeQuery,
  navigatorStandalone: boolean,
): boolean {
  return displayMode.matches || navigatorStandalone;
}

export function isIosDevice(
  userAgent: string,
  maxTouchPoints: number,
): boolean {
  return (
    userAgent.includes("iPad") ||
    userAgent.includes("iPhone") ||
    userAgent.includes("iPod") ||
    (userAgent.includes("Macintosh") && maxTouchPoints > 1)
  );
}

export function canOfferPwaInstall(
  installed: boolean,
  nativePromptAvailable: boolean,
  ios: boolean,
): boolean {
  return !installed && (nativePromptAvailable || ios);
}

export function registerQmushServiceWorker(
  options: RegistrationOptions,
): ServiceWorkerRegistrationResult {
  if (!options.enabled) {
    return { registration: Promise.resolve(undefined) };
  }

  let resolveRegistration:
    | ((registration: ServiceWorkerRegistrationLike | undefined) => void)
    | undefined;
  const registration = new Promise<ServiceWorkerRegistrationLike | undefined>(
    (resolve) => {
      resolveRegistration = resolve;
    },
  );
  const settleRegistration = (
    value: ServiceWorkerRegistrationLike | undefined,
  ): void => {
    resolveRegistration?.(value);
  };

  options.addWindowListener("load", () => {
    void options
      .register(SERVICE_WORKER_PATH, { scope: "/", updateViaCache: "none" })
      .then(settleRegistration, () => {
        settleRegistration(undefined);
      });
  });

  return { registration };
}

export function watchForServiceWorkerUpdate(
  registration: ServiceWorkerRegistrationLike,
  hasController: () => boolean,
  onUpdate: () => void,
): void {
  const notifyWhenInstalled = (): void => {
    const worker = registration.installing;
    worker?.addEventListener("statechange", () => {
      if (worker.state === "installed" && hasController()) {
        onUpdate();
      }
    });
  };

  if (registration.waiting !== null && registration.waiting !== undefined) {
    onUpdate();
  }
  registration.addEventListener("updatefound", notifyWhenInstalled);
}

export function isBeforeInstallPromptEvent(
  event: Event,
): event is BeforeInstallPromptEvent {
  return (
    "prompt" in event &&
    typeof event.prompt === "function" &&
    "userChoice" in event
  );
}
